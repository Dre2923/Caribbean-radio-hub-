# Caribbean Radio & Events Platform — Build Manifest

Production master build for Android, iPhone/iPad, and Windows (macOS deferred).

## Control Rule

Build one numbered step at a time. Test it. Stop and wait for explicit
confirmation ("continue") before starting the next step. Never chain
multiple steps together without an explicit go-ahead each time.

## Project Standard

- Premium, production-grade Caribbean radio, events, voice-control,
  advertising, discovery, and community platform.
- Public listener experience is free initially.
- The application MUST NOT rebroadcast, restream, record, cache for
  redistribution, or host a radio station's copyrighted broadcast unless
  proper additional rights are obtained. Architecture: the user's device
  connects directly to the radio station's authorized stream URL; the
  application never proxies or stores audio.
- Every component: modular, backed up before modification, documented,
  testable, monitored, secure, accessible, responsive, production-ready,
  cross-platform where applicable, free/open-source first.
- Every database write requires error handling and rollback protection
  built in from the start.

## Cross-Cutting Non-Negotiables (apply to every step, not a one-time task)

- **Real, persistent database** — Postgres is the actual data store for
  this platform, not a mock or a placeholder to swap out later. Every
  step's data lives there, with the error-handling/rollback discipline
  from Step 01 (`withTransaction`).
- **HTTPS end-to-end, always** — this ships to Apple (iOS/iPadOS — App
  Transport Security rejects plain HTTP by default), Android, and Windows.
  The API always speaks plain HTTP internally; production deployment must
  put a TLS-terminating proxy/load balancer/hosting edge in front of it,
  and `TRUST_PROXY` must be configured for that deployment (see
  `backend/README.md` → "Production deployment: HTTPS and TRUST_PROXY").
  No client ships pointed at a plain-HTTP base URL.
- **Real due diligence on user data security, every step** — not a
  checklist pass at the end. Verify against a live server/database, not
  just unit tests; look for what a config or a library's defaults get
  wrong (e.g. Fastify 5's `logger`→`loggerInstance` rename, fast-redact's
  non-recursive wildcards, `pgm.sql`'s identifier-vs-literal escaping —
  all real bugs caught this way, not hypothetical).
- **Multi-platform readiness** — Android, iOS, iPadOS, and Windows are all
  in scope (macOS deferred). Decisions in the backend (auth, data
  handling, HTTPS) need to hold up under each platform's own store
  requirements, not just "work in a browser."

## Launch Countries (13, database-driven so more can be added later)

Jamaica, Trinidad & Tobago, Dominica, Saint Lucia, Grenada,
Antigua & Barbuda, Barbados, Puerto Rico, Saint Vincent & the Grenadines,
Saint Kitts & Nevis, Anguilla, Turks and Caicos, Bahamas.

## Front-End Design Direction (Step 40 and all UI work)

- Fortune-500 / top-tier commercial standard.
- Strong, animated interactive buttons and dropdown menus with real
  hover/pressed/loading/focus/disabled/error states.
- Caribbean color palette: warm sunset tones, ocean blues/teals, vibrant
  green accents. Authentic ocean-themed imagery/motion without hurting
  readability.
- Voice command must be fast/responsive, minimal lag.
- WCAG-verified accessibility (font sizes, alignment).
- Avoid: cheap carnival-flyer look, overloaded tourism-site look, generic
  templates, dark unreadable UI, random bright colors everywhere.

## Step Sequence (64 steps)

- 01–11: Foundation / Backend
- 12–18: Caribbean Radio Master Catalog (13-country list applies)
- 19–23: Stream Reliability
- 24–30: Events Database
- 31–33: Admin Dashboard
- 34–38: Voice System
- 39–45: Flutter Client & Premium Design (revised design direction applies)
- 46–50: Platform Audio
- 51–55: User Features
- 56–57: Advertising
- 58–60: Reliability / Security / Monitoring
- 61: Competitor Failure Test Suite
- 62: Background Update Workers
- 63: Production QA
- 64: Production Release Gate

## Progress Log

| Step | Description | Status |
|------|-------------|--------|
| 01   | Foundation & Backend Bootstrap (Node.js + TypeScript + PostgreSQL, health check, error/rollback-safe DB access, migrations, tests) | Built and confirmed |
| 02   | Core Domain Schema — Countries (13 launch countries, seeded, database-driven) & Users (bcrypt-hashed passwords, unique email), `GET /countries`, `POST /users`. Hardening pass: generic 500 messages (no internal/DB detail leaked to clients), bcrypt 72-byte limit enforced instead of silently truncated, countryId type + foreign-key validation, process-level crash handlers. Security-review pass: added `@fastify/helmet` (security headers) and `@fastify/rate-limit` (100/min global, 5/min on registration), defaulted Postgres TLS certificate validation to on, fixed a seed-migration bug found during review (schema and seed data must be separate migrations; `pgm.db.query` gives real parameter binding, `pgm.sql`'s `{}` syntax escapes for identifiers, not string values). | Hardened and security-reviewed, confirmed |
| 03   | Authentication — `POST /auth/login` (JWT, 7d expiry) and `GET /me` (protected via `app.authenticate`). No email enumeration: identical error message and constant-time bcrypt comparison (against a dummy hash) whether the email is unknown or the password is wrong. `JWT_SECRET` required at startup, validated ≥32 chars. Login rate-limited to 5/min. | Built and security-reviewed, confirmed |
| 04   | Observability foundation — one shared `pino` logger used everywhere (Fastify's per-request logs, DB pool, startup, crash handlers), request-id correlation (`x-request-id`, generated or passed through, echoed in the response and every log line for that request), and secret redaction (auth headers, password/token fields). Found and fixed a real bug during review: the initial redact paths (`*.password` etc.) only matched fields nested exactly one level deep and silently let a top-level `password`/`token` field straight through — added a regression test (`tests/logger.test.ts`) against a real pino instance that would have caught it, and confirmed it does by reintroducing the bug and watching the test fail. Also hit and fixed a Fastify 5 API change along the way: a pre-built logger instance goes through `loggerInstance`, not `logger` (which now only accepts config objects). **Addendum** (production HTTPS/proxy readiness): added `TRUST_PROXY` config — without it, `request.ip` (what rate-limiting keys on) resolves to the TLS-terminating proxy's address for every client once actually deployed, not the real caller, silently merging every user into one rate-limit bucket. Added `tests/trustProxy.test.ts` for the hop-counting logic and manually verified live: spoofed `X-Forwarded-For` cannot bypass the login rate limit by default, and correctly does get independent buckets once `TRUST_PROXY=1` is set. Also documented the standing HTTPS/multi-platform/database requirements as Cross-Cutting Non-Negotiables above so they don't need restating every step. | Built, security-reviewed, and confirmed |
| 05   | CI/CD pipeline (`.github/workflows/backend-ci.yml`) — install, build, lint, migrate a real Postgres service container, run the full test suite, and `npm audit --audit-level=high` (fails the build on high/critical vulnerabilities) on every push/PR touching `backend/**`. Makes the exact manual verification sequence run at every step so far into an automatic, unskippable gate on every future change. Verified by simulating the identical sequence locally against a matching database (same env vars, same commands, same fresh `npm ci` install) before ever pushing, then confirmed the actual live run on GitHub (not just the local simulation) — all steps green in both. | Built, verified live on GitHub, confirmed |
| —    | **Full audit of Steps 01–05** ("ready for production" check): git state clean and fully pushed; no stray debug code/TODOs/hardcoded secrets found; no secrets ever committed to git history; migrated the database from absolute zero end-to-end; ran the full endpoint suite (all 9 cases: health, health/db, countries, register, duplicate-register 409, login, /me with/without token, 404) against a fresh migration; verified the **compiled production build** (not just `tsx` dev mode) end to end — plain JSON logs (no dev pretty-printing), security headers present, graceful SIGTERM shutdown, and fail-fast startup errors (exit 1, clear message) for a missing `DATABASE_URL`, missing `JWT_SECRET`, and a too-short `JWT_SECRET`. Found one real gap: `eslint@8.57.1` was EOL/deprecated upstream — migrated to ESLint 10 + flat config (`eslint.config.js`, `typescript-eslint` unified package), and proved the new config actually catches violations (not just "runs without error") by deliberately introducing an unused-variable violation and watching it get flagged before reverting. TypeScript deliberately stays on the stable 5.9.x line rather than the very new 7.0 rewrite — a documented choice, not an oversight. | Audited and confirmed production-ready |
