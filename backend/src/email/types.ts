export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The one thing every call site in this app depends on - never a specific
 * vendor's SDK. Swapping providers (SMTP relay, a future provider-specific
 * API integration) means writing a new implementation of this interface,
 * not touching any code that sends an email.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
