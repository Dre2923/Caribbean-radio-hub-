import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import {
  claimPendingEmails,
  countEmailsByStatus,
  enqueueEmail,
  markEmailFailed,
  markEmailSent,
} from "../src/repositories/emailOutboxRepository.js";
import { processPendingEmails } from "../src/email/outboxWorker.js";
import type { EmailMessage, EmailProvider } from "../src/email/types.js";

const SUBJECT_PREFIX = "[test:email-outbox:";

function uniqueSubject(label: string): string {
  return `${SUBJECT_PREFIX}${label}:${Date.now()}:${Math.random().toString(36).slice(2)}]`;
}

async function countBySubject(subject: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM email_outbox WHERE subject = $1",
    [subject],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function statusBySubject(subject: string): Promise<{ status: string; attempts: number }> {
  const result = await pool.query<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM email_outbox WHERE subject = $1",
    [subject],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`No outbox row found for subject ${subject}`);
  }
  return row;
}

// This file runs its DB-backed assertions against the real (shared, never
// truncated between local runs) test database - other test files' rows can
// be sitting alongside these at any point, so every assertion here targets
// rows by this file's own uniquely-generated subjects rather than assuming
// anything about the table's total contents. Rows this file creates are
// swept up at the very end so repeated local runs don't accumulate
// permanently-pending rows that could eventually crowd a real claim
// query's LIMIT.
afterAll(async () => {
  await pool.query("DELETE FROM email_outbox WHERE subject LIKE $1", [`${SUBJECT_PREFIX}%`]);
  await pool.end();
});

describe("email outbox repository", () => {
  it("enqueues within the caller's transaction and rolls back with it", async () => {
    const subject = uniqueSubject("rollback");

    // Simulates the exact failure the outbox pattern exists to prevent:
    // something after the enqueue fails, and the whole unit of work -
    // including the email that was about to be queued - must never have
    // happened at all.
    await expect(
      withTransaction(async (client) => {
        await enqueueEmail(client, {
          to: "rollback-test@example.com",
          subject,
          text: "should never persist",
          html: "<p>should never persist</p>",
        });
        throw new Error("simulated failure after enqueue");
      }),
    ).rejects.toThrow("simulated failure after enqueue");

    expect(await countBySubject(subject)).toBe(0);
  });

  it("commits the enqueued email once the transaction commits", async () => {
    const subject = uniqueSubject("commit");

    await withTransaction(async (client) => {
      await enqueueEmail(client, {
        to: "commit-test@example.com",
        subject,
        text: "should persist",
        html: "<p>should persist</p>",
      });
    });

    expect(await countBySubject(subject)).toBe(1);
    const row = await statusBySubject(subject);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("claims pending emails atomically and never lets two concurrent claims see the same row", async () => {
    const subjects = [uniqueSubject("claim-a"), uniqueSubject("claim-b"), uniqueSubject("claim-c")];
    await withTransaction(async (client) => {
      for (const subject of subjects) {
        await enqueueEmail(client, {
          to: "claim-test@example.com",
          subject,
          text: "claim test",
          html: "<p>claim test</p>",
        });
      }
    });

    // FOR UPDATE SKIP LOCKED is what makes this safe under real concurrent
    // worker instances - firing two claims at once proves neither can
    // claim a row the other already has, rather than trusting the SQL
    // comment. A generous limit keeps this true even with unrelated rows
    // (this file's own leftovers, or other test files running in
    // parallel against the same live database) mixed in.
    const [first, second] = await Promise.all([claimPendingEmails(100), claimPendingEmails(100)]);
    const claimedIds = new Set([...first, ...second].map((email) => email.id));
    expect(claimedIds.size).toBe(first.length + second.length);

    const claimedSubjects = new Set([...first, ...second].map((email) => email.subject));
    for (const subject of subjects) {
      expect(claimedSubjects.has(subject)).toBe(true);
    }
  });

  it("marks a claimed email sent", async () => {
    const subject = uniqueSubject("sent");
    await withTransaction(async (client) => {
      await enqueueEmail(client, {
        to: "sent-test@example.com",
        subject,
        text: "sent test",
        html: "<p>sent test</p>",
      });
    });

    await claimPendingEmails(100);
    const target = (
      await pool.query<{ id: number }>("SELECT id FROM email_outbox WHERE subject = $1", [subject])
    ).rows[0];
    if (!target) throw new Error("expected row to exist");

    await markEmailSent(target.id);

    const row = await statusBySubject(subject);
    expect(row.status).toBe("sent");
  });

  it("returns a failed send to pending until it hits the attempt cap, then marks it failed", async () => {
    const subject = uniqueSubject("failure");
    await withTransaction(async (client) => {
      await enqueueEmail(client, {
        to: "failure-test@example.com",
        subject,
        text: "failure test",
        html: "<p>failure test</p>",
      });
    });

    const before = (
      await pool.query<{ id: number }>("SELECT id FROM email_outbox WHERE subject = $1", [subject])
    ).rows[0];
    if (!before) throw new Error("expected row to exist");

    await markEmailFailed(before.id, 4, "simulated transient error");
    expect((await statusBySubject(subject)).status).toBe("pending");

    await markEmailFailed(before.id, 5, "simulated permanent error");
    const row = await statusBySubject(subject);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
  });

  it("counts emails by status", async () => {
    const subject = uniqueSubject("count");
    await withTransaction(async (client) => {
      await enqueueEmail(client, {
        to: "count-test@example.com",
        subject,
        text: "count test",
        html: "<p>count test</p>",
      });
    });

    expect(await countEmailsByStatus("pending")).toBeGreaterThanOrEqual(1);

    // Cleaned up immediately rather than left pending indefinitely - this
    // assertion only needed the row to exist for a moment, and an
    // abandoned 'pending' row would otherwise sit in every future claim
    // query's way for as long as this local database lives.
    const row = (
      await pool.query<{ id: number }>("SELECT id FROM email_outbox WHERE subject = $1", [subject])
    ).rows[0];
    if (row) await markEmailSent(row.id);
  });
});

describe("email outbox worker", () => {
  it("sends each claimed email independently - one failure doesn't stop the rest of the batch", async () => {
    const okSubject = uniqueSubject("worker-ok");
    const failSubject = uniqueSubject("worker-fail");

    await withTransaction(async (client) => {
      await enqueueEmail(client, {
        to: "worker-ok@example.com",
        subject: okSubject,
        text: "ok",
        html: "<p>ok</p>",
      });
      await enqueueEmail(client, {
        to: "worker-fail@example.com",
        subject: failSubject,
        text: "fail",
        html: "<p>fail</p>",
      });
    });

    const sent: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        if (message.subject === failSubject) {
          throw new Error("simulated provider outage");
        }
        sent.push(message);
      },
    };

    await processPendingEmails(provider);

    expect(sent.some((m) => m.subject === okSubject)).toBe(true);
    expect((await statusBySubject(okSubject)).status).toBe("sent");

    // A provider failure sends the email back to 'pending' for the next
    // poll to retry, rather than losing it or blocking the rest of the
    // batch that succeeded.
    const failedRow = await statusBySubject(failSubject);
    expect(failedRow.status).toBe("pending");
    expect(failedRow.attempts).toBe(1);
  });
});
