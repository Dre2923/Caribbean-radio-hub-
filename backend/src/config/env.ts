import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
};
