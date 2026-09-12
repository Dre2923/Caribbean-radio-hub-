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

// The API always speaks plain HTTP itself; HTTPS is terminated in front of
// it (a load balancer, reverse proxy, or the hosting platform's edge) -
// that's what lets the actual traffic to Apple/Android/Windows clients be
// TLS-only. But that means every request Fastify sees arrives "from" that
// proxy, not the real client, unless it's told which hop(s) to trust and
// read X-Forwarded-* from. Left untrusted (the safe default), rate
// limiting keyed on IP would silently limit the whole app together instead
// of per client. TRUST_PROXY must be set to the real deployment's proxy
// count/address(es) once one exists - never `true` unless you have
// verified nothing except your own proxy can reach the app directly,
// since that blindly trusts client-supplied X-Forwarded-* headers.
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  const hopCount = Number(raw);
  return Number.isInteger(hopCount) && hopCount > 0 ? hopCount : raw;
}

export interface SmtpEnvConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

// Undefined (not a set of empty-string defaults) whenever SMTP isn't
// configured, so callers can do `if (env.smtp)` to choose the real
// provider vs. the dev-safe console one - see src/email/provider.ts.
// SMTP_USER/PASSWORD are optional since some relays (an internal
// corporate SMTP server, a provider used from a trusted network) don't
// require auth; SMTP_HOST/EMAIL_FROM being set is what signals "a real
// provider is configured" at all. Takes a plain source object (defaulting
// to process.env) rather than reading it directly, the same reason
// parseTrustProxy takes its raw value as a parameter: a pure function of
// its input is trivially unit-testable without mutating global state.
export function parseSmtpConfig(
  source: Record<string, string | undefined> = process.env,
): SmtpEnvConfig | undefined {
  const host = source.SMTP_HOST;
  if (!host) {
    return undefined;
  }
  const from = source.EMAIL_FROM;
  if (!from) {
    throw new Error(
      "Missing required environment variable: EMAIL_FROM (required whenever SMTP_HOST is set)",
    );
  }
  return {
    host,
    port: Number(source.SMTP_PORT ?? 587),
    secure: (source.SMTP_SECURE ?? "false").toLowerCase() === "true",
    user: source.SMTP_USER ?? "",
    password: source.SMTP_PASSWORD ?? "",
    from,
  };
}

// Used to build the actual link inside the password-reset email. Required
// in production (no silent guess about where the frontend lives); defaults
// to a typical local dev server address otherwise so the flow works
// out-of-the-box without extra setup.
function frontendUrl(): string {
  const fallback = process.env.NODE_ENV === "production" ? undefined : "http://localhost:5173";
  return required("FRONTEND_URL", fallback).replace(/\/+$/, "");
}

// A "break-glass" admin bootstrap: any account whose email appears here is
// promoted to the 'admin' role the moment it registers or logs in (see
// ensureBootstrapAdminRole in src/repositories/usersRepository.ts). This is
// deliberately the only way to become an admin right now - there's no
// admin-management endpoint yet (that's the Admin Dashboard, Steps 31-33),
// so a purely config-driven allowlist is what makes app.requireAdmin
// (src/app.ts) actually reachable and testable end-to-end today rather than
// shipping a guard nothing can ever pass. Removing an email from this list
// does NOT demote anyone automatically - that's a deliberate one-way
// bootstrap (an operator typo here must never silently lock out the only
// admin); real demotion is a future admin-management concern. Pure
// function of its input, like parseTrustProxy/parseSmtpConfig, for the same
// testability reason.
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
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
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Off by default in production - this API isn't a published public
  // contract yet, so the full route/schema map isn't exposed unless
  // explicitly opted into. Always on outside production for local/CI use.
  enableApiDocs: process.env.NODE_ENV !== "production" || process.env.ENABLE_API_DOCS === "true",
  smtp: parseSmtpConfig(),
  // How often the email outbox worker (src/email/outboxWorker.ts) polls
  // for pending emails to send.
  emailOutboxIntervalMs: Number(process.env.EMAIL_OUTBOX_INTERVAL_MS ?? 10_000),
  // How often the stream health-check worker (src/stationHealth/
  // healthCheckWorker.ts) sweeps the whole active catalog. Deliberately
  // much longer than the email outbox's poll interval: each tick makes a
  // real outbound network request to every active station's own
  // third-party stream server, so this needs to be a good network
  // citizen, not just fast - 5 minutes by default is frequent enough for
  // a "that day's" reliability signal without hammering real stations
  // unnecessarily.
  stationHealthCheckIntervalMs: Number(process.env.STATION_HEALTH_CHECK_INTERVAL_MS ?? 300_000),
  frontendUrl: frontendUrl(),
  adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
};
