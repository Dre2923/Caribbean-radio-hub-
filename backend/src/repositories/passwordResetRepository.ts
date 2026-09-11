import crypto from "node:crypto";
import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

const TOKEN_BYTES = 32; // 256 bits - not guessable, so a fast hash below is fine
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Issues a new reset token for a user, invalidating any of their
 * outstanding ones first (only one live reset link at a time - an older
 * link a user forgot about shouldn't stay usable after they request a
 * fresh one). Returns the raw token; only the caller gets to see it
 * (destined for an email), the database only ever stores its hash.
 */
export async function createPasswordResetToken(userId: number): Promise<string> {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await withTransaction(async (client) => {
    await client.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [userId],
    );
    await client.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, tokenHash, expiresAt],
    );
  });

  return rawToken;
}

export interface ValidResetToken {
  id: number;
  userId: number;
}

/**
 * Looks up a raw token by its hash and returns it only if it exists,
 * hasn't been used, and hasn't expired - all three checked in SQL so
 * there's one place this logic can't drift out of sync with itself.
 */
export async function findValidPasswordResetToken(rawToken: string): Promise<ValidResetToken | null> {
  const tokenHash = hashToken(rawToken);
  const result = await query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? { id: row.id, userId: row.user_id } : null;
}

export async function markPasswordResetTokenUsed(id: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [id]);
  });
}
