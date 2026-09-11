# Backend — Foundation Service (Step 01)

Foundation/backend bootstrap for the Caribbean Radio & Events Platform:
a Fastify + TypeScript API with a PostgreSQL connection layer that has
error handling and transactional rollback protection built in.

## Stack

- Node.js 20+, TypeScript
- Fastify (HTTP server)
- PostgreSQL via `pg`, migrations via `node-pg-migrate`
- Vitest for tests

## Local setup

```bash
cp .env.example .env          # then set JWT_SECRET (openssl rand -base64 48)
docker compose up -d          # starts local Postgres on :5432
npm install
npm run migrate:up            # applies all pending migrations
npm run dev                   # starts the API on :3000
```

## Endpoints

- `GET /health` — liveness check, no external dependencies.
- `GET /health/db` — readiness check, verifies the database connection.
- `GET /countries` — lists the active launch countries (database-driven).
- `POST /users` — registers a user account. Body: `{ email, password, displayName, countryId? }`.
  Passwords are hashed with bcrypt before storage and are never returned in
  responses.
  - `400` — invalid email, password outside 8–72 bytes (bcrypt's hashing
    limit — longer inputs are rejected rather than silently truncated),
    displayName missing/too long, or countryId not a positive integer.
  - `409` — email already registered.
  - `400` — countryId doesn't match a known country.
- `POST /auth/login` — body: `{ email, password }`. Returns `{ token, user }`
  on success (a JWT, `JWT_EXPIRES_IN` default `7d`) or `401` with the exact
  same message (`"Invalid email or password"`) whether the email doesn't
  exist or the password is wrong — timing is kept constant too (a real
  bcrypt comparison always runs, against a dummy hash when the email isn't
  found), so a login attempt can't be used to enumerate registered emails.
  Rate-limited to 5/min, the tightest limit in the API.
- `GET /me` — requires `Authorization: Bearer <token>`. Returns the current
  user's profile. `401` on a missing/invalid/expired/tampered token.

## Security baseline

- **Security headers**: `@fastify/helmet` is registered globally (CSP, HSTS,
  X-Content-Type-Options, X-Frame-Options, etc.).
- **Rate limiting**: `@fastify/rate-limit` caps the API at 100 req/min per
  client by default; `POST /users` has its own tighter limit (5/min) since
  it hashes a password and writes to the DB on every call.
- **TLS certificate validation**: when `PGSSL=true`, the Postgres connection
  validates the server certificate by default. Only set
  `PGSSL_REJECT_UNAUTHORIZED=false` for a provider with a self-signed chain
  you specifically trust — never as a default, since it accepts any
  certificate (a MITM risk). A startup warning is logged if it's off.
- **No raw error detail to clients**: see "Error handling" below.
- **Seed data uses real parameter binding**: migrations insert data via
  `pgm.db.query(sql, [...values])` ($1/$2 placeholders), not string
  interpolation, even for static/trusted seed lists — one consistent, safe
  path for every migration that touches data.
- **JWT_SECRET is required and validated**: the server refuses to start with
  a secret shorter than 32 characters. Generate one with
  `openssl rand -base64 48`.
- **No email enumeration via login**: see `POST /auth/login` above.

## Observability

- **Structured logging**: a single shared `pino` instance (`src/utils/logger.ts`)
  is used everywhere - Fastify's own per-request logs, the DB pool, startup,
  and process-level crash handlers - so every log line shares the same
  level/format/redaction config. Pretty-printed and colorized outside
  production; plain JSON in production for log aggregation.
- **Request correlation**: every request gets an id (`x-request-id`, taken
  from an incoming header if present, otherwise a generated UUID), echoed
  back in the response header and included in every log line for that
  request - including the error-handler's log line, so a failure can be
  traced back to its exact request/response pair.
- **Redaction**: `Authorization`/`Cookie` headers and any `password`,
  `passwordHash`, or `token` field (top-level or nested one level) are
  redacted before they reach a log line, at the top-level AND nested one
  level deep - fast-redact's wildcard paths aren't recursive, so both forms
  are listed explicitly. Covered by `tests/logger.test.ts` against a real
  pino instance, not just the config in isolation.
- `LOG_LEVEL` overrides the default (`debug` outside production, `info` in
  production, `silent` under the test runner).

## Error handling

Unexpected failures (e.g. a database outage) are logged in full server-side
(`src/app.ts` error handler) but only ever return a generic
`{"status":"error","message":"Internal server error"}` with a `500` to the
client — internal error text and stack traces never reach the response.
Expected 4xx errors (validation, bad JSON) still return their specific
message. `src/index.ts` also installs `unhandledRejection`/`uncaughtException`
handlers so an unexpected error can't silently crash or hang the process.

## Database access patterns

- `src/db/pool.ts` — shared connection pool. `query()` wraps every call in
  error handling/logging; a pool-level `error` listener prevents an idle
  client error from crashing the process.
- `src/db/transaction.ts` — `withTransaction(fn)` wraps a set of writes in
  `BEGIN`/`COMMIT`, rolling back automatically on any failure. All future
  multi-statement writes should go through this helper rather than issuing
  raw `BEGIN`/`COMMIT` calls inline.

## Testing

```bash
npm test
```

Tests use Fastify's `inject()` so the HTTP-layer tests do not require a
running server or database.
