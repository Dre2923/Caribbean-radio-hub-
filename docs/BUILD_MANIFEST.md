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
| 03   | Authentication — `POST /auth/login` (JWT, 7d expiry) and `GET /me` (protected via `app.authenticate`). No email enumeration: identical error message and constant-time bcrypt comparison (against a dummy hash) whether the email is unknown or the password is wrong. `JWT_SECRET` required at startup, validated ≥32 chars. Login rate-limited to 5/min. | Built and security-reviewed — awaiting confirmation to continue |
