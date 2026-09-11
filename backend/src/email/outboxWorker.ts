import {
  claimPendingEmails,
  markEmailSent,
  markEmailFailed,
} from "../repositories/emailOutboxRepository.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { EmailProvider } from "./types.js";

const BATCH_SIZE = 10;

/**
 * Claims and attempts to send one batch of pending emails. Each email's
 * outcome is independent - one failure doesn't stop the rest of the batch,
 * and a transient provider error (the network blip this whole design
 * exists to tolerate) sends the email back to 'pending' for the next poll
 * rather than losing it.
 */
export async function processPendingEmails(provider: EmailProvider): Promise<void> {
  const pending = await claimPendingEmails(BATCH_SIZE);
  for (const email of pending) {
    try {
      await provider.send(email);
      await markEmailSent(email.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = email.attempts + 1;
      logger.error("Failed to send outbox email", {
        emailId: email.id,
        attempts,
        error: message,
      });
      await markEmailFailed(email.id, attempts, message);
    }
  }
}

/**
 * Starts polling the outbox on an interval. Returns a stop function -
 * index.ts calls it on SIGINT/SIGTERM so shutdown doesn't leave a
 * dangling timer (the same graceful-shutdown discipline as everything
 * else there).
 */
export function startEmailOutboxWorker(provider: EmailProvider): () => void {
  const interval = setInterval(() => {
    processPendingEmails(provider).catch((err) => {
      logger.error("Email outbox worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.emailOutboxIntervalMs);

  // Never let this timer alone keep the process alive - matters for tests
  // and any short-lived script that imports this module.
  interval.unref();

  return () => clearInterval(interval);
}
