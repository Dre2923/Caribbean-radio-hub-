// Shared between every route that accepts user profile/credential fields
// (POST /users, PATCH /me, POST /me/password) so the rules can't quietly
// drift apart between them.

export const MAX_EMAIL_LENGTH = 254; // RFC 5321
export const MIN_PASSWORD_LENGTH = 8;
// bcrypt silently ignores any bytes beyond 72 - without a cap, two different
// passwords sharing that prefix would hash identically. JSON Schema's
// minLength/maxLength count UTF-16 code units, not UTF-8 bytes, so this
// can't be expressed declaratively - callers must check it explicitly.
export const MAX_PASSWORD_BYTES = 72;
export const MAX_DISPLAY_NAME_LENGTH = 120; // matches the users.display_name column

export function passwordByteLengthError(password: string): string | null {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
}
