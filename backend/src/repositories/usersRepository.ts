import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

export type UserRole = "user" | "admin";

export interface User {
  id: number;
  email: string;
  displayName: string;
  countryId: number | null;
  createdAt: string;
  role: UserRole;
}

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  country_id: number | null;
  created_at: string;
  role: UserRole;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export class InvalidCountryError extends Error {
  constructor(countryId: number) {
    super(`No country with id ${countryId}`);
    this.name = "InvalidCountryError";
  }
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
  countryId?: number | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    countryId: row.country_id,
    createdAt: row.created_at,
    role: row.role,
  };
}

export async function createUser(input: NewUser): Promise<User> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, country_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, country_id, created_at, role`,
        [input.email, input.passwordHash, input.displayName, input.countryId ?? null],
      );
      return toUser(result.rows[0]);
    });
  } catch (err) {
    if (hasPgErrorCode(err, UNIQUE_VIOLATION)) {
      throw new EmailAlreadyRegisteredError(input.email);
    }
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION) && input.countryId != null) {
      throw new InvalidCountryError(input.countryId);
    }
    throw err;
  }
}

export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string; tokenVersion: number }) | null> {
  const result = await query<UserRow & { password_hash: string; token_version: number }>(
    "SELECT id, email, password_hash, display_name, country_id, created_at, role, token_version FROM users WHERE email = $1",
    [email],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { ...toUser(row), passwordHash: row.password_hash, tokenVersion: row.token_version };
}

export async function findUserById(id: number): Promise<User | null> {
  const result = await query<UserRow>(
    "SELECT id, email, display_name, country_id, created_at, role FROM users WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function findPasswordHashById(id: number): Promise<string | null> {
  const result = await query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0]?.password_hash ?? null;
}

export interface ProfileUpdate {
  email?: string;
  displayName?: string;
  countryId?: number | null;
}

export async function updateUserProfile(id: number, updates: ProfileUpdate): Promise<User | null> {
  // Built from only the fields actually present, so a partial update never
  // overwrites a column the caller didn't intend to touch (email absent
  // from `updates` must leave the existing email alone, not null it out).
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.email !== undefined) {
    values.push(updates.email);
    setClauses.push(`email = $${values.length}`);
  }
  if (updates.displayName !== undefined) {
    values.push(updates.displayName);
    setClauses.push(`display_name = $${values.length}`);
  }
  if (updates.countryId !== undefined) {
    values.push(updates.countryId);
    setClauses.push(`country_id = $${values.length}`);
  }

  if (setClauses.length === 0) {
    return findUserById(id);
  }

  setClauses.push("updated_at = now()");
  values.push(id);

  try {
    return await withTransaction(async (client) => {
      const result = await client.query<UserRow>(
        `UPDATE users SET ${setClauses.join(", ")}
         WHERE id = $${values.length}
         RETURNING id, email, display_name, country_id, created_at, role`,
        values,
      );
      return result.rows[0] ? toUser(result.rows[0]) : null;
    });
  } catch (err) {
    if (hasPgErrorCode(err, UNIQUE_VIOLATION) && updates.email !== undefined) {
      throw new EmailAlreadyRegisteredError(updates.email);
    }
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION) && updates.countryId != null) {
      throw new InvalidCountryError(updates.countryId);
    }
    throw err;
  }
}

export async function updatePasswordHash(id: number, passwordHash: string): Promise<void> {
  await withTransaction(async (client) => {
    // token_version bumps in the same statement as the password change so
    // the two can never go out of sync (e.g. a crash between two separate
    // writes leaving the password changed but old tokens still trusted).
    // See migrations/1700000003000_users_token_version.cjs for why this
    // exists: a JWT's signature being valid says nothing about whether the
    // password has changed since it was issued.
    await client.query(
      "UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2",
      [passwordHash, id],
    );
  });
}

export async function getTokenVersion(id: number): Promise<number | null> {
  const result = await query<{ token_version: number }>(
    "SELECT token_version FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0]?.token_version ?? null;
}

// Deliberately NOT embedded in the JWT: doing so would mean a demoted
// admin's existing tokens keep passing app.requireAdmin until they expire
// (up to JWT_EXPIRES_IN, 7d by default) or the account happens to trigger a
// token_version bump some other way. Looking this up fresh on every
// admin-gated request costs one query on a low-volume path and closes that
// gap outright - a demotion takes effect on the very next request, not
// eventually.
export async function getUserRole(id: number): Promise<UserRole | null> {
  const result = await query<{ role: UserRole }>("SELECT role FROM users WHERE id = $1", [id]);
  return result.rows[0]?.role ?? null;
}

export async function setUserRole(id: number, role: UserRole): Promise<User | null> {
  return withTransaction(async (client) => {
    const result = await client.query<UserRow>(
      `UPDATE users SET role = $1, updated_at = now() WHERE id = $2
       RETURNING id, email, display_name, country_id, created_at, role`,
      [role, id],
    );
    return result.rows[0] ? toUser(result.rows[0]) : null;
  });
}

// The only path to 'admin' right now - see env.ts parseAdminEmails for why
// this config-driven allowlist exists at all instead of an admin-management
// endpoint (which doesn't exist yet; that's the Admin Dashboard, Steps
// 31-33). Deliberately one-way: an email absent from `adminEmails` never
// demotes an existing admin here, only ever promotes a listed one. Callers
// (registration, login) pass `env.adminEmails` explicitly rather than this
// module reading env itself, keeping the repository layer free of a config
// dependency and the bootstrap set easy to control in tests.
export async function ensureBootstrapAdminRole(
  id: number,
  email: string,
  adminEmails: string[],
): Promise<UserRole> {
  if (!adminEmails.includes(email)) {
    return (await getUserRole(id)) ?? "user";
  }
  const currentRole = await getUserRole(id);
  if (currentRole === "admin") {
    return "admin";
  }
  const updated = await setUserRole(id, "admin");
  return updated?.role ?? "admin";
}

export async function deleteUser(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query("DELETE FROM users WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
