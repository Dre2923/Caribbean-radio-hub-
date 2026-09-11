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
- **Self-healing wherever practical** — detect failures and recover or
  clean up automatically rather than just crashing. Already in place:
  `withTransaction` rolls back automatically on any write failure (Step 01);
  the DB pool's `error` listener stops an idle-client error from crashing
  the process (Step 01); `unhandledRejection`/`uncaughtException` handlers
  log and shut down cleanly instead of hanging (Step 02); Fastify's global
  error handler catches every request-level failure and always returns a
  response, never leaves a request hanging (Step 02/04). Apply the same
  standard going forward: a component that can retry, roll back, or
  degrade gracefully should, rather than propagating a hard crash.

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
| 06   | API contract formalization — replaced hand-rolled if/else request validation with real JSON Schema (Fastify's native AJV validator) on `POST /users`, plus response schemas across all routes (self-documenting, and fast-json-stringify strips any unlisted field before it can leak — e.g. a password hash could never reach a response even by accident). Added `@fastify/swagger` + `@fastify/swagger-ui` for live OpenAPI docs at `/docs`, off by default in production (`ENABLE_API_DOCS`). `POST /auth/login` deliberately keeps its body *unschemaed*, documented inline as to why: schema validation would return a different status/message than a wrong password, undermining the anti-enumeration property from Step 03. Found and fixed two real bugs, not hypotheticals: (1) `/auth/login`'s success response was missing `createdAt` against the shared user schema, which fast-json-stringify failed to serialize — a real 500 on every successful login, caught by testing the actual live flow end-to-end, not just validation cases. (2) A genuine **authentication-bypass race condition** in `app.authenticate`: its catch block called `reply.status(401).send(...)` without `return`-ing it; `reply.sent` is a getter over the raw response's `writableEnded`, an asynchronous I/O condition, so under timing-dependent conditions Fastify could invoke the protected route handler even after the 401 was "sent." Found via test flakiness, confirmed by reproducing it (the `/me` handler actually ran and hit the database with an unverified token's claims), and fixed structurally — not by adding `return` (which doesn't fully close the race) but by letting `jwtVerify()`'s rejection propagate as a thrown error, which Fastify routes through a completely separate, non-racy error branch that never reaches the route handler at all. Verified with a dedicated stress test (`tests/authenticate.test.ts`, 80 concurrent invalid-token requests, zero tolerance for any non-401) that reliably failed against the old code and passes against the new. Also caught and fixed a broken test-tampering method along the way: flipping a JWT's last base64url character doesn't reliably invalidate an HS256 signature (the last character of a 32-byte signature has 2 "don't-care" padding bits) — confirmed directly by decoding, fixed by corrupting a middle character instead. | Built, two real bugs found and fixed, stress-tested, confirmed |
| 07   | User profile management — completes user CRUD, which was a real gap: accounts could be created and logged into but never updated or removed. `PATCH /me` (partial update: email/displayName/countryId, reuses the same uniqueness/FK error handling as registration), `POST /me/password` (requires the current password before changing it — a stolen/shared-device token alone can't lock the real owner out), `DELETE /me` (requires the password — permanent hard delete, relevant for GDPR/CCPA-style right-to-erasure). Shared validation constants (email/password/displayName limits) extracted into `src/utils/userValidation.ts` so `POST /users` and the new `/me` routes can't quietly drift apart. Password-change and delete both rate-limited to 5/min as sensitive, abuse-prone actions. Verified live end-to-end against real Postgres, not just validation cases: profile update persists and is reflected on the next `GET /me`; password change actually changes which password logs in (old fails, new works) and is rejected with no change when the current password is wrong; email-uniqueness is enforced on update (two real accounts, second blocked from taking the first's email); account deletion actually removes the row (post-delete `GET /me` returns 404, post-delete login returns the same generic "Invalid email or password" as a never-registered email — no signal that the account used to exist) and is rejected with no change when the password is wrong. Also specifically checked the 204 (no-body) responses for a schema-mismatch crash, the exact class of bug found in Step 06 — verified clean. | Built, verified live end-to-end, confirmed |
| 08   | Token invalidation on password change — a real gap surfaced by Step 07's own work: JWTs are stateless, so changing a password did not revoke a token already issued (e.g. stolen via XSS or a shared device) - it stayed fully valid for up to its full 7-day life, defeating the entire point of a password change as a security response. Added `users.token_version` (migration `1700000003000_users_token_version`), embedded as `tv` in the JWT at login, bumped atomically in the same statement as the password update, and compared against the account's current value on every authenticated request (`app.authenticate`) - a mismatch is a `401`, thrown (not manually `reply.send()`'d) to stay on the same race-free error path established in Step 06. Two deliberate safety nets to avoid over-tightening: a token without a `tv` claim skips the check rather than failing closed (covers tokens signed directly in tests), and a `token_version` lookup for a since-deleted account is left to the route's own lookup to produce its usual `404`, not folded into this check as a `401`. Verified two ways: extensive live curl testing against a running server (old token works before the change, the exact same token used to make the password change is rejected immediately after, a fresh login's token keeps working, deletion still gets a clean 404) and a permanent automated regression test (`tests/tokenVersion.test.ts`) run against a real, migrated database rather than mocked - proved the test actually catches the bug by temporarily disabling the check and watching it fail before restoring it. Discovered along the way that CI's `DATABASE_URL` (set at the job level, migrated before tests run) already gives the test suite a real database to work with when a test needs one; set up the local equivalent (`caribbean_radio_hub_test`, migrated) so this could be verified locally before ever pushing, and documented the one-time local setup step in the README. | Built, real DB-backed regression test proven to catch the bug, confirmed |
| 09   | Password reset ("forgot password") flow — the single most glaring gap in the auth system: `POST /me/password` requires knowing the *current* password, so there was no way for a user to recover an account if they forgot it. Added `POST /auth/password-reset/request` and `POST /auth/password-reset/confirm`, with `password_reset_tokens` (migration `1700000004000`). Tokens are 256-bit random values (`crypto.randomBytes`), hashed with a fast SHA-256 (not bcrypt — that slowness defends against guessing a *low-entropy* secret, which doesn't apply to a 256-bit random value; a conscious tool choice, not a downgrade), single-use, expire after 1 hour, and requesting a new one invalidates any earlier unused one for the same account. `request` always returns the same response regardless of whether the email is registered; `confirm` always returns the same generic message for any invalid/expired/used/unknown token — same anti-enumeration posture as login. `confirm` reuses Step 08's `token_version` bump, so completing a reset also kills every session issued before it, not just the credential — the scenario this exists for (recovering a compromised account) would be undermined otherwise. No email provider is integrated yet, so the raw token is logged (clearly labeled as a placeholder) rather than emailed — documented prominently in the README as a real gap that must be closed with an actual send (SES/SendGrid/Postmark) before production launch, not silently left as-is. Verified live end-to-end against a running server (request → confirm → old password dead, new password works, pre-reset session token dead, token replay rejected, superseded token rejected while the newer one still works) and locked in with a permanent regression test (`tests/passwordReset.test.ts`) against a real, migrated database that spies on the logger to capture the token the same way a real email integration eventually would. | Built, verified live end-to-end and with a real-DB regression test, confirmed |
| —    | **Fix: Step 09's flagged gap — Fortune-500-grade password reset email delivery.** Replaced the "log the token" placeholder with a real, provider-agnostic transactional email pipeline: a **transactional outbox** (`email_outbox` table, migration `1700000005000`) where issuing the reset token and enqueueing its email now commit inside **one shared database transaction** (`createPasswordResetToken` was refactored to take the caller's transaction client instead of opening its own, the same pattern `enqueueEmail` already used) — a crash or error between the two can never leave a valid token with no email ever queued for it. A background worker (`src/email/outboxWorker.ts`), started and gracefully stopped alongside the HTTP server in `index.ts`, polls the outbox on an interval and sends independently per email, so a slow or down email provider can never make the request itself hang or fail; a failed send returns to `pending` for retry (capped at 5 attempts, then `failed` — a dead letter, never silently dropped). Claiming is done via a `FOR UPDATE SKIP LOCKED` CTE, so running more than one worker instance can never double-send — correct under future horizontal scaling from day one, not deferred. Delivery itself is SMTP-based (`nodemailer`), working with any real provider (SES, Postmark, SendGrid, Mailgun, Resend, or a corporate relay) via plain `SMTP_*`/`EMAIL_FROM` env vars — a provider swap is a config change, never new code; with no `SMTP_HOST` set, a dev-safe `ConsoleEmailProvider` is selected instead (loudly logged as such every time), so local dev/CI need no email setup while production cannot silently ship without one. Added a real HTML+text password-reset email template with the actual reset link (new `FRONTEND_URL` env var, required in production). Discovered and fixed two real cross-file test-isolation bugs while building this out, not hypotheticals: (1) an `afterAll(pool.end())` nested inside the wrong `describe` block closed the DB pool before a later sibling `describe` in the same file had run, breaking its DB calls; (2) once multiple test files could enqueue into and claim from the *same* live `email_outbox` table concurrently, assertions that assumed "this batch contains exactly the one email I just sent" became genuinely racy against other files' rows — fixed by matching on the specific recipient/subject a test cares about instead of the batch's total size, and by serializing test-file execution (`fileParallelism: false`) since these are integration tests against one shared, non-isolated real Postgres instance, not by papering over the race with timing hacks. Verified: full up/down/up migration cycle on both the dev and test databases; clean `tsc` build and `eslint` pass; the full test suite (66 tests across 13 files, including new `tests/emailOutbox.test.ts` and `tests/emailConfig.test.ts`, and a rewritten `tests/passwordReset.test.ts` that now captures the token through the real enqueue→claim→send pipeline instead of spying on a log line) run three consecutive times with zero flakes; `npm audit` clean; and a full live end-to-end run against a running compiled-equivalent dev server — register → request reset → background worker picks it up within one poll interval and "sends" it via `ConsoleEmailProvider` with the correct recipient/subject/reset-link body → confirm with that token succeeds → login with the new password succeeds → `SIGTERM` stops the worker and the server cleanly. | Built, real bugs found and fixed, verified live end-to-end, confirmed |
