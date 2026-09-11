import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

export interface User {
  id: number;
  email: string;
  displayName: string;
  countryId: number | null;
  createdAt: string;
}

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  country_id: number | null;
  created_at: string;
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
  };
}

export async function createUser(input: NewUser): Promise<User> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, country_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, country_id, created_at`,
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
    "SELECT id, email, password_hash, display_name, country_id, created_at, token_version FROM users WHERE email = $1",
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
    "SELECT id, email, display_name, country_id, created_at FROM users WHERE id = $1",
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
         RETURNING id, email, display_name, country_id, created_at`,
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

export async function deleteUser(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query("DELETE FROM users WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
