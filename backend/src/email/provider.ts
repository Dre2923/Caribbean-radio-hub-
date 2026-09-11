import { env, type SmtpEnvConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { ConsoleEmailProvider } from "./providers/consoleEmailProvider.js";
import { SmtpEmailProvider } from "./providers/smtpEmailProvider.js";
import type { EmailProvider } from "./types.js";

// Takes the resolved SMTP config as a parameter (defaulting to env.smtp)
// rather than reading env directly, so the selection logic is a pure,
// unit-testable function of its input - the same reasoning as
// parseTrustProxy/parseSmtpConfig taking their raw values as parameters.
export function createEmailProvider(smtp: SmtpEnvConfig | undefined = env.smtp): EmailProvider {
  if (smtp) {
    return new SmtpEmailProvider(smtp);
  }
  // Loud on purpose: this is silent data loss waiting to happen the
  // moment this runs against real user traffic without anyone noticing
  // SMTP was never configured. See README.md "Password reset email
  // delivery" for what setting it up for real involves.
  logger.warn(
    "No SMTP_HOST configured - using ConsoleEmailProvider. Emails are logged, not sent. " +
      "Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/EMAIL_FROM before production use.",
  );
  return new ConsoleEmailProvider();
}
