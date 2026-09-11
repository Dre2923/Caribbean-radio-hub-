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
cp .env.example .env
docker compose up -d          # starts local Postgres on :5432
npm install
npm run migrate:up            # applies migrations/1700000000000_init.cjs
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
