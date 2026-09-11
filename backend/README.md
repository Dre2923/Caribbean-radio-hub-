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
