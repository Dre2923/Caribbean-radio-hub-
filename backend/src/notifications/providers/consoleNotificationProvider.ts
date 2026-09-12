import { logger } from "../../utils/logger.js";
import type { PushMessage, PushProvider } from "../types.js";

/**
 * Dev-safe default used whenever no real FCM credential is configured (no
 * FCM_SERVICE_ACCOUNT_JSON set) - the identical role
 * email/providers/consoleEmailProvider.ts's ConsoleEmailProvider plays for
 * email. Never actually sends anything; logs the message so every call
 * site is fully testable without a real Firebase project. This must never
 * be what's actually selected once real user traffic exists -
 * createPushProvider() (../provider.ts) logs a loud warning every time
 * this is chosen.
 */
export class ConsoleNotificationProvider implements PushProvider {
  async send(message: PushMessage): Promise<void> {
    logger.info("Push notification 'sent' via ConsoleNotificationProvider (no real FCM credential configured)", {
      token: message.token,
      title: message.title,
      body: message.body,
      data: message.data,
    });
  }
}
