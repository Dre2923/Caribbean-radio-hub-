// User Features (Step 53): the device push-token registry backing
// POST/GET/DELETE /v1/me/push-tokens. See migration
// 1700000021000_push_tokens's own comment for the table's design
// reasoning (a plain UNIQUE(token) table, not a junction table like Step
// 51's favorites - a device token belongs to exactly one account at a
// time, so re-registering an existing token overwrites its owner rather
// than creating a second row).

import { query } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";

export const PUSH_PLATFORMS = ["android", "ios", "windows"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const DEFAULT_PUSH_TOKEN_LIST_LIMIT = 50;
export const MAX_PUSH_TOKEN_LIST_LIMIT = 100;

// Step 58/OWASP API4 (Unrestricted Resource Consumption): without a cap, a
// compromised or malicious account could register an unbounded number of
// distinct device tokens over time (each a real, permanent database row) -
// there's no other limit anywhere on this table's growth per account.
// Generous relative to how many real devices/reinstalls one person
// realistically has (phone, tablet, a reinstall or two) while still being
// a genuine, enforced bound rather than no bound at all.
export const MAX_PUSH_TOKENS_PER_USER = 20;

const FOREIGN_KEY_VIOLATION = "23503";

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// Raised only in the narrow race already handled the identical way for
// GET /v1/me itself (routes/me.ts): the JWT is validly signed and its
// token_version still matches, but the account row is gone (deleted from
// another session between issuing the token and this request).
export class PushTokenUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "PushTokenUserNotFoundError";
  }
}

export class TooManyPushTokensError extends Error {
  constructor() {
    super(
      `Account already has the maximum of ${MAX_PUSH_TOKENS_PER_USER} registered devices - ` +
        "remove one before adding another",
    );
    this.name = "TooManyPushTokensError";
  }
}

export interface PushToken {
  id: number;
  token: string;
  platform: PushPlatform;
  createdAt: string;
  updatedAt: string;
}

interface PushTokenRow {
  id: number;
  token: string;
  platform: PushPlatform;
  created_at: string;
  updated_at: string;
}

function toPushToken(row: PushTokenRow): PushToken {
  return {
    id: row.id,
    token: row.token,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Idempotent upsert, not a plain INSERT: re-registering an already-known
// token (the client's own periodic refresh, or a different account now
// logged in on the same physical device) overwrites user_id/platform and
// bumps updated_at, rather than erroring on the UNIQUE(token) constraint -
// this *is* the "overwrites on every client-reported refresh" behavior
// docs/ARCHITECTURE_PLAN.md's own research calls for.
export async function registerPushToken(
  userId: number,
  token: string,
  platform: PushPlatform,
): Promise<PushToken> {
  try {
    return await withTransaction(async (client) => {
      // Locks every row this user currently owns for the rest of this
      // transaction, so two concurrent registrations can never both read
      // "under the cap" and both proceed past it - the identical FOR
      // UPDATE-based serialization usersRepository.setUserRole already
      // uses for its own "count this account's rows, then decide" check
      // (the last-remaining-admin protection).
      const existing = await client.query<{ id: number; token: string }>(
        "SELECT id, token FROM push_tokens WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      // Re-registering a token this same account already owns (the
      // client's own periodic refresh) is never new growth - only a
      // genuinely new-to-this-account token (brand new, or transferred
      // from a different account) counts against the cap.
      const alreadyOwnsThisToken = existing.rows.some((row) => row.token === token);
      if (!alreadyOwnsThisToken && existing.rows.length >= MAX_PUSH_TOKENS_PER_USER) {
        throw new TooManyPushTokensError();
      }

      const result = await client.query<PushTokenRow>(
        `INSERT INTO push_tokens (user_id, token, platform)
         VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()
         RETURNING id, token, platform, created_at, updated_at`,
        [userId, token, platform],
      );
      return toPushToken(result.rows[0]);
    });
  } catch (err) {
    if (err instanceof TooManyPushTokensError) {
      throw err;
    }
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new PushTokenUserNotFoundError();
    }
    throw err;
  }
}

// Scoped to (userId, token) together, never token alone - a caller can
// only ever remove their own device's registration, even if they somehow
// knew another account's exact token string. Idempotent: removing a token
// that isn't registered (to this account or at all) is still a clean
// success, the identical posture as Step 51's removeFavoriteStation.
export async function removePushToken(userId: number, token: string): Promise<void> {
  await query("DELETE FROM push_tokens WHERE user_id = $1 AND token = $2", [userId, token]);
}

export interface PushTokenListResult {
  pushTokens: PushToken[];
  total: number;
}

export async function listPushTokens(
  userId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<PushTokenListResult> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_PUSH_TOKEN_LIST_LIMIT, 1),
    MAX_PUSH_TOKEN_LIST_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await query<PushTokenRow & { total_count: string }>(
    `SELECT id, token, platform, created_at, updated_at, COUNT(*) OVER() AS total_count
     FROM push_tokens
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  return { pushTokens: result.rows.map(toPushToken), total };
}

// Step 54: the send-side registry lookup the favorite-station-availability
// notifier (and any future notification fan-out) needs - given a set of
// user ids, every currently-registered token across all of them, in one
// round trip rather than one query per user.
export async function listPushTokensForUsers(userIds: number[]): Promise<PushToken[]> {
  if (userIds.length === 0) return [];
  const result = await query<PushTokenRow>(
    "SELECT id, token, platform, created_at, updated_at FROM push_tokens WHERE user_id = ANY($1)",
    [userIds],
  );
  return result.rows.map(toPushToken);
}

// Used when a provider reports a token as permanently invalid
// (InvalidPushTokenError) - deletes by the row's own id (already known to
// the caller from the same listPushTokensForUsers call) rather than
// needing the owning user_id too.
export async function deletePushTokenById(id: number): Promise<void> {
  await query("DELETE FROM push_tokens WHERE id = $1", [id]);
}
