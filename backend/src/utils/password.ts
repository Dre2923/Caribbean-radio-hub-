import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export function verifyPassword(plainTextPassword: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, hash);
}

// A valid bcrypt hash that doesn't correspond to any real account. Login
// compares against this when the email isn't found, so a login attempt
// takes the same time either way - without it, "no such user" would return
// near-instantly while a real user's wrong password waits on a full bcrypt
// comparison, letting an attacker enumerate valid emails purely by timing.
export const DUMMY_PASSWORD_HASH =
  "$2b$12$vXFrNTyDlj4VVyuBa4AkL.sLXgbxiAYcmRTkHoebsIFRs20oFLKPu";
