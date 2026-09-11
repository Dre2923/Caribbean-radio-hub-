/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Transactional outbox pattern: writing an email here happens in the same
// database transaction as whatever triggered it (e.g. issuing a password
// reset token), so the two can never go out of sync - a crash right after
// creating a reset token can't silently mean the email never gets queued.
// A separate background worker (src/email/outboxWorker.ts) is what
// actually sends these and updates their status, decoupling "did we
// durably record that this email should be sent" (must be reliable) from
// "did the email provider's API call succeed just now" (best-effort, with
// retries) - a slow or down email provider must never make the API
// request that triggered it fail or hang.
exports.up = (pgm) => {
  pgm.createTable("email_outbox", {
    id: "id",
    to_email: { type: "citext", notNull: true },
    subject: { type: "text", notNull: true },
    body_text: { type: "text", notNull: true },
    body_html: { type: "text", notNull: true },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "pending",
      // 'sending' is a real state, not just an implementation detail: the
      // worker atomically claims a batch of rows by flipping them from
      // 'pending' to 'sending' in the same statement (a CTE + FOR UPDATE
      // SKIP LOCKED), so a second worker instance can never claim the same
      // row - required for correctness the moment this runs as more than
      // one process, not a "someday" concern to bolt on later.
      check: "status IN ('pending', 'sending', 'sent', 'failed')",
    },
    attempts: { type: "integer", notNull: true, default: 0 },
    last_error: { type: "text" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    sent_at: { type: "timestamptz" },
  });

  // The worker's claim query always filters on status='pending' ordered by
  // creation time.
  pgm.createIndex("email_outbox", ["status", "created_at"]);
};

exports.down = (pgm) => {
  pgm.dropTable("email_outbox");
};
