import { env, type FcmEnvConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { ConsoleNotificationProvider } from "./providers/consoleNotificationProvider.js";
import { FcmPushProvider } from "./providers/fcmPushProvider.js";
import type { PushProvider } from "./types.js";

// Takes the resolved FCM config as a parameter (defaulting to env.fcm)
// rather than reading env directly - the identical shape as
// email/provider.ts's createEmailProvider, for the identical reason (a
// pure, unit-testable function of its input).
export function createPushProvider(fcm: FcmEnvConfig | undefined = env.fcm): PushProvider {
  if (fcm) {
    return new FcmPushProvider(fcm);
  }
  // Loud on purpose - the identical reasoning as createEmailProvider's own
  // warning: this is silent no-op notification delivery waiting to happen
  // the moment this runs against real user traffic without anyone noticing
  // FCM was never configured.
  logger.warn(
    "No FCM_SERVICE_ACCOUNT_JSON configured - using ConsoleNotificationProvider. Push " +
      "notifications are logged, not sent. Set FCM_SERVICE_ACCOUNT_JSON (the full service " +
      "account JSON key from the Firebase console) before production use.",
  );
  return new ConsoleNotificationProvider();
}
