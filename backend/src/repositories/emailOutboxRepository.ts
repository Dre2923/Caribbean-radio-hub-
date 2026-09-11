import type { PoolClient } from "pg";
import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

export interface OutboxEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Enqueues within the caller's own transaction (it never opens one of its
 * own, unlike every other repository function here) - the whole point of
 * the outbox pattern is that this write lands atomically with whatever
 * triggered it (e.g. creating a password reset token), so a crash right
 * after can't mean the token exists but the email was never queued.
 */
export async function enqueueEmail(client: PoolClient, email: OutboxEmail): Promise<void> {
  await client.query(
    "INSERT INTO email_outbox (to_email, subject, body_text, body_html) VALUES ($1, $2, $3, $4)",
    [email.to, email.subject, email.text, email.html],
  );
}

export interface PendingEmail {
  id: number;
  to: string;
  subject: string;
  text: string;
  html: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

/**
 * Atomically claims up to `limit` pending emails by flipping them to
 * 'sending' in the same statement that selects them (a CTE + FOR UPDATE
 * SKIP LOCKED), so a second worker process can never claim the same row -
 * required the moment this runs as more than one instance, not something
 * safe to defer "until we actually scale out."
 */
export async function claimPendingEmails(limit: number): Promise<PendingEmail[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: number;
      to_email: string;
      subject: string;
      body_text: string;
      body_html: string;
      attempts: number;
    }>(
      `WITH claimed AS (
         SELECT id FROM email_outbox
         WHERE status = 'pending' AND attempts < $1
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox
       SET status = 'sending'
       WHERE id IN (SELECT id FROM claimed)
       RETURNING id, to_email, subject, body_text, body_html, attempts`,
      [MAX_ATTEMPTS, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html,
      attempts: row.attempts,
    }));
  });
}

export async function markEmailSent(id: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("UPDATE email_outbox SET status = 'sent', sent_at = now() WHERE id = $1", [
      id,
    ]);
  });
}

/**
 * Sends a claimed email back to 'pending' (for the next poll to retry) if
 * it hasn't hit MAX_ATTEMPTS yet, or 'failed' (a dead letter - inspectable,
 * never silently dropped) once it has.
 */
export async function markEmailFailed(id: number, attempts: number, error: string): Promise<void> {
  const nextStatus = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE email_outbox SET status = $1, attempts = $2, last_error = $3 WHERE id = $4",
      [nextStatus, attempts, error, id],
    );
  });
}

export async function countEmailsByStatus(
  status: "pending" | "sending" | "sent" | "failed",
): Promise<number> {
  const result = await query<{ count: string }>(
    "SELECT count(*) FROM email_outbox WHERE status = $1",
    [status],
  );
  return Number(result.rows[0]?.count ?? 0);
}
