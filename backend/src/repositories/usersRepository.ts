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
  // Step 31: only ever non-null once this account's role has actually been
  // changed from its created default - either an admin's explicit action
  // (roleChangedByUserId set to that admin) or the automated ADMIN_EMAILS
  // bootstrap promotion (roleChangedByUserId null - no human admin acted).
  // Both stay null for an account whose role has never changed.
  roleChangedAt: string | null;
  roleChangedByUserId: number | null;
}

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  country_id: number | null;
  created_at: string;
  role: UserRole;
  role_changed_at: string | null;
  role_changed_by_user_id: number | null;
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

// The base column list every plain user lookup/write selects or returns -
// centralized once so adding a column (as Step 31 just did) means editing
// it here rather than hunting down every RETURNING/SELECT list in this
// file and risking one silently drifting out of sync with toUser().
const USER_COLUMNS =
  "id, email, display_name, country_id, created_at, role, role_changed_at, role_changed_by_user_id";

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
    roleChangedAt: row.role_changed_at,
    roleChangedByUserId: row.role_changed_by_user_id,
  };
}

export async function createUser(input: NewUser): Promise<User> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, country_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${USER_COLUMNS}`,
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
    `SELECT ${USER_COLUMNS}, password_hash, token_version FROM users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { ...toUser(row), passwordHash: row.password_hash, tokenVersion: row.token_version };
}

export async function findUserById(id: number): Promise<User | null> {
  const result = await query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
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
         RETURNING ${USER_COLUMNS}`,
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

export class LastAdminError extends Error {
  constructor() {
    super("cannot change the role of the last remaining admin");
    this.name = "LastAdminError";
  }
}

// actorUserId: who's performing this write, recorded as
// role_changed_by_user_id - the identical "who did this, and null means
// the system did" convention already established for
// radio_stations.updateStation's actorUserId (Step 17: a human admin's id,
// or null for Step 19-23's automated monitor). Defaults to null so the
// existing ensureBootstrapAdminRole call site below - a config-driven
// promotion, not an admin's own action - needs no change to keep working
// exactly as it did before this parameter existed.
export async function setUserRole(
  id: number,
  role: UserRole,
  actorUserId: number | null = null,
): Promise<User | null> {
  return withTransaction(async (client) => {
    if (role === "user") {
      // Locks every current admin row for the rest of this transaction, so
      // two concurrent demotions can never both read "at least one other
      // admin exists" and each independently decide it's safe to proceed -
      // the same FOR UPDATE-based serialization the email outbox worker's
      // claim query already uses (see docs/BUILD_MANIFEST.md's Step 09
      // email-delivery fix), applied here to a correctness invariant
      // instead of a work-queue claim. Real-world admin counts are small
      // and role changes are rare, so locking every admin row for the
      // duration of one UPDATE is a negligible cost for closing off a
      // permanent-lockout scenario outright.
      const admins = await client.query<{ id: number }>(
        "SELECT id FROM users WHERE role = 'admin' FOR UPDATE",
      );
      if (admins.rows.length === 1 && admins.rows[0].id === id) {
        throw new LastAdminError();
      }
    }
    const result = await client.query<UserRow>(
      `UPDATE users
       SET role = $1, role_changed_at = now(), role_changed_by_user_id = $2, updated_at = now()
       WHERE id = $3
       RETURNING ${USER_COLUMNS}`,
      [role, actorUserId, id],
    );
    return result.rows[0] ? toUser(result.rows[0]) : null;
  });
}

// The only path to 'admin' before Step 31 - see env.ts parseAdminEmails for
// why this config-driven allowlist exists at all. Now joined by
// PATCH /v1/admin/users/:id (routes/users.ts), a real admin-management
// endpoint. Deliberately one-way: an email absent from `adminEmails` never
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

export const DEFAULT_USER_LIST_LIMIT = 50;
export const MAX_USER_LIST_LIMIT = 100;

export interface UserListFilter {
  // Case-insensitive substring match against email OR displayName - the
  // two fields an admin searching for a specific person would actually
  // remember, the same ILIKE-based search as every other listing in this
  // build (stations' name, events' title).
  search?: string;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

export interface UserListResult {
  users: User[];
  total: number;
}

// Same reasoning as stationsRepository.ts/eventsRepository.ts's identical
// helper (each kept local rather than shared, following this codebase's
// established per-repository-module precedent): the raw search text is
// escaped before being wrapped in %...% and bound as a parameter, so a
// literal "%" or "_" in a search term is matched literally instead of
// being misread as a wildcard. Not a SQL-injection concern either way -
// this is a bound parameter, never concatenated into the query string.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listUsers(filter: UserListFilter = {}): Promise<UserListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.role !== undefined) {
    values.push(filter.role);
    conditions.push(`role = $${values.length}`);
  }
  if (filter.search !== undefined && filter.search.trim() !== "") {
    values.push(`%${escapeLikePattern(filter.search.trim())}%`);
    conditions.push(`(email ILIKE $${values.length} OR display_name ILIKE $${values.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_USER_LIST_LIMIT, 1), MAX_USER_LIST_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);
  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  const result = await query<UserRow & { total_count: string }>(
    `SELECT ${USER_COLUMNS}, COUNT(*) OVER() AS total_count
     FROM users
     ${where}
     ORDER BY created_at ASC
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values,
  );
  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  return { users: result.rows.map(toUser), total };
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
