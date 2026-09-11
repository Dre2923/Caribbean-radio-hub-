# Backend — Foundation Service (Step 01)

Foundation/backend bootstrap for the Caribbean Radio & Events Platform:
a Fastify + TypeScript API with a PostgreSQL connection layer that has
error handling and transactional rollback protection built in.

## Stack

- Node.js 20+, TypeScript 5.9.x (deliberately not the 7.0 rewrite yet —
  too new for a production dependency)
- Fastify (HTTP server)
- PostgreSQL via `pg`, migrations via `node-pg-migrate`
- Vitest for tests, ESLint 10 (flat config, `eslint.config.js`)

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
- `PATCH /me` — requires auth. Body: `{ email?, displayName?, countryId? }`,
  at least one field. Updates only the fields present. `409` on an email
  already taken by another account, `400` on invalid input or an unknown
  countryId. Password changes are deliberately not part of this endpoint —
  see `POST /me/password` below.
- `POST /me/password` — requires auth. Body: `{ currentPassword, newPassword }`.
  Changing a password requires proving the current one first, so a
  stolen/shared-device token alone can't lock the real owner out. `401` if
  `currentPassword` is wrong, `400` if `newPassword` is outside 8–72 bytes.
  `204` on success. Rate-limited to 5/min.
- `DELETE /me` — requires auth. Body: `{ password }`. Permanently deletes
  the account after verifying the password, for the same reason as password
  changes above. `401` if the password is wrong. `204` on success.
  Rate-limited to 5/min.

Full interactive API docs (OpenAPI 3, generated from the route schemas
below) are served at `/docs` outside production, or when `ENABLE_API_DOCS=true`
is set — off by default in production since this isn't a published public
API yet. Raw spec at `/docs/json`.

## Request validation

`POST /users` validates its body against a JSON Schema (email format,
password length, displayName length, countryId type) rather than hand-rolled
if/else checks — Fastify rejects malformed requests before the handler ever
runs, and the same schema documents the endpoint in `/docs`. Two things stay
outside the schema deliberately:
- The bcrypt 72-byte password ceiling (JSON Schema's `maxLength` counts
  UTF-16 code units, not UTF-8 bytes, so it can't express this correctly).
- `POST /auth/login`'s body has no schema at all: a schema-validation
  failure would return a different status/message than a wrong password,
  undermining the anti-enumeration behavior above. Every invalid login
  input returns the identical 401.

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

## Production deployment: HTTPS and TRUST_PROXY

This API always speaks plain HTTP itself. In production it must be served
behind something that terminates TLS in front of it — a load balancer,
reverse proxy, or the hosting platform's own edge — so that every request
from the Android/iOS/iPad/Windows clients travels over HTTPS end to end.
This isn't optional: iOS's App Transport Security rejects plain-HTTP API
calls by default, and it's the baseline expectation for handling user data
(credentials, profiles) on every platform this ships to.

Once it's behind that proxy, set `TRUST_PROXY` (see `.env.example`) to how
many proxy hops are yours — e.g. `TRUST_PROXY=1` for a single load
balancer. Without it, `request.ip` (what rate-limiting keys on) resolves to
the proxy's address for every client instead of the real caller, silently
merging every user into one shared rate-limit bucket. Verified manually:
with `TRUST_PROXY` unset, spoofing `X-Forwarded-For` cannot bypass the
login rate limit (still 429 on the 6th attempt regardless of the header);
with `TRUST_PROXY=1`, distinct `X-Forwarded-For` values correctly get
independent buckets. `tests/trustProxy.test.ts` covers the hop-counting
logic itself (an off-by-one here would silently under- or over-trust).
Never set `TRUST_PROXY=true` unless you've verified nothing but your own
proxy can reach the app directly — it trusts client-supplied
`X-Forwarded-*` headers unconditionally.

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

## CI

`.github/workflows/backend-ci.yml` runs on every push/PR touching
`backend/**`: install, build, lint, migrate a real Postgres service
container, run the full test suite, and `npm audit --audit-level=high`
(fails the build on a high/critical vulnerability) — the same sequence
manually verified by hand at every step so far, now enforced automatically
on every future change rather than relying on remembering to run it.
