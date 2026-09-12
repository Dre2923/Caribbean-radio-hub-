export interface PushMessage {
  token: string;
  title: string;
  body: string;
  // Arbitrary application-specific key/value pairs delivered alongside the
  // visible notification (e.g. { stationId: "12" } so a tapped
  // notification can deep-link) - FCM requires every value to be a string,
  // unlike the notification title/body.
  data?: Record<string, string>;
}

/**
 * The one thing every future call site in this app depends on - never a
 * specific vendor's SDK, the identical reasoning as email/types.ts's
 * EmailProvider. Swapping providers, or adding a second one (e.g. a future
 * web-push provider for a browser client), means writing a new
 * implementation of this interface, not touching any code that sends a
 * notification.
 */
export interface PushProvider {
  send(message: PushMessage): Promise<void>;
}

// Raised when the provider itself reports that a specific token is
// permanently invalid (uninstalled app, expired/rotated token) rather than
// a transient send failure - the caller's signal to stop using this token
// (e.g. delete its pushTokensRepository row) rather than retry it.
export class InvalidPushTokenError extends Error {
  constructor(
    public readonly token: string,
    detail: string,
  ) {
    super(`Push token is no longer valid: ${detail}`);
    this.name = "InvalidPushTokenError";
  }
}
