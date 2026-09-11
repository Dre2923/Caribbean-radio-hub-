import { logger } from "../../utils/logger.js";
import type { EmailMessage, EmailProvider } from "../types.js";

/**
 * Dev-safe default used whenever no real SMTP provider is configured
 * (no SMTP_HOST set). Never actually sends anything - it logs the message
 * so the whole flow (including outbox status/retry tracking) is fully
 * testable without a real email account. This must never be what's
 * actually selected once real user traffic exists - createEmailProvider()
 * (../provider.ts) logs a loud warning every time this is chosen, and
 * README.md documents wiring up a real provider as a pre-launch
 * requirement, not an optional nice-to-have.
 */
export class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    logger.info("Email 'sent' via ConsoleEmailProvider (no real SMTP provider configured)", {
      to: message.to,
      subject: message.subject,
      bodyText: message.text,
    });
  }
}
