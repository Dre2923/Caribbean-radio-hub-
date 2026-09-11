import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const MIN_JWT_SECRET_LENGTH = 32;

function requiredJwtSecret(): string {
  const secret = required("JWT_SECRET");
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${secret.length}). ` +
        "Generate one with: openssl rand -base64 48",
    );
  }
  return secret;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  pgSsl: (process.env.PGSSL ?? "false").toLowerCase() === "true",
  // Certificate validation stays on by default even when SSL is enabled -
  // only an explicit PGSSL_REJECT_UNAUTHORIZED=false (e.g. a managed
  // Postgres provider with a self-signed chain) turns it off, so nobody
  // silently ends up accepting any certificate (a MITM risk).
  pgSslRejectUnauthorized: (process.env.PGSSL_REJECT_UNAUTHORIZED ?? "true").toLowerCase() !== "false",
  jwtSecret: requiredJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  // Vitest sets VITEST=true regardless of NODE_ENV, so this stays quiet in
  // the test run's output without depending on how NODE_ENV happens to be
  // set. Override with LOG_LEVEL for a specific test that wants to inspect
  // log output.
  logLevel:
    process.env.LOG_LEVEL ??
    (process.env.VITEST ? "silent" : process.env.NODE_ENV === "production" ? "info" : "debug"),
};
