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

## API versioning

Every business-domain route is served under `/v1` (e.g. `POST /v1/users`,
not `POST /users`). `GET /health` and `GET /health/db` are the deliberate
exception — they're infrastructure endpoints (load balancer / uptime
monitor / orchestrator probes configured once against a fixed path), not
API contract surface a client depends on, so they stay unversioned.

This app has no shipped clients yet, so starting versioned costs nothing
today — but mobile clients (Android, iOS/iPadOS, Windows) are a
Cross-Cutting Non-Negotiable, and once real installs exist in app stores, a
given install can be stuck on whatever API shape it was built against for
as long as that platform's review/update cycle takes. Retrofitting
versioning after that point means doing it under live traffic with old
clients already depending on the unversioned shape; doing it now, before
any client exists, costs a route prefix and nothing else.

**Policy going forward**: an additive, backward-compatible change (a new
field, a new endpoint, a new optional parameter) ships straight into `/v1`
— it doesn't need a new version. A genuine breaking change (removing/renaming
a field, changing a status code's meaning, changing what a field requires)
gets a new `/v2` plugin registered alongside `/v1` in `src/app.ts` (see the
comment there), so existing clients on `/v1` keep working unchanged while
new clients move to `/v2` — `/v1` is never mutated out from under whoever
is still calling it.

## Endpoints

- `GET /health` — liveness check, no external dependencies.
- `GET /health/db` — readiness check, verifies the database connection.
- `GET /v1/countries` — lists the active launch countries (database-driven).
- `POST /v1/users` — registers a user account. Body: `{ email, password, displayName, countryId? }`.
  Passwords are hashed with bcrypt before storage and are never returned in
  responses.
  - `400` — invalid email, password outside 8–72 bytes (bcrypt's hashing
    limit — longer inputs are rejected rather than silently truncated),
    displayName missing/too long, or countryId not a positive integer.
  - `409` — email already registered.
  - `400` — countryId doesn't match a known country.
- `POST /v1/auth/login` — body: `{ email, password }`. Returns `{ token, user }`
  on success (a JWT, `JWT_EXPIRES_IN` default `7d`) or `401` with the exact
  same message (`"Invalid email or password"`) whether the email doesn't
  exist or the password is wrong — timing is kept constant too (a real
  bcrypt comparison always runs, against a dummy hash when the email isn't
  found), so a login attempt can't be used to enumerate registered emails.
  Rate-limited to 5/min, the tightest limit in the API.
- `POST /v1/auth/password-reset/request` — body: `{ email }`. Always returns
  the same `200` and generic message regardless of whether the email is
  registered (no enumeration). If it is, a single-use, 1-hour-expiring
  reset token is generated and emailed (see "Password reset email delivery"
  below). Rate-limited to 5/min.
- `POST /v1/auth/password-reset/confirm` — body: `{ token, newPassword }`.
  Sets the new password, invalidates the reset token, and invalidates
  every session token issued before the reset (same mechanism as
  `POST /v1/me/password`) — a reset triggered by a suspected compromise kills
  any session an attacker might already hold, not just the credential.
  `400` with a generic "Invalid or expired reset token" for any invalid,
  expired, already-used, or unknown token — the same message regardless of
  which, so this can't be used to probe token validity either. Requesting
  a new reset link invalidates any earlier unused one for that account.
  Rate-limited to 5/min.
- `GET /v1/me` — requires `Authorization: Bearer <token>`. Returns the current
  user's profile. `401` on a missing/invalid/expired/tampered token.
- `PATCH /v1/me` — requires auth. Body: `{ email?, displayName?, countryId? }`,
  at least one field. Updates only the fields present. `409` on an email
  already taken by another account, `400` on invalid input or an unknown
  countryId. Password changes are deliberately not part of this endpoint —
  see `POST /v1/me/password` below.
- `POST /v1/me/password` — requires auth. Body: `{ currentPassword, newPassword }`.
  Changing a password requires proving the current one first, so a
  stolen/shared-device token alone can't lock the real owner out. `401` if
  `currentPassword` is wrong, `400` if `newPassword` is outside 8–72 bytes.
  `204` on success. Rate-limited to 5/min. Also invalidates every token
  issued before this change (see "Token invalidation" below) — a stolen
  token stops working the moment the real owner changes their password,
  not up to 7 days later when it happens to expire.
- `DELETE /v1/me` — requires auth. Body: `{ password }`. Permanently deletes
  the account after verifying the password, for the same reason as password
  changes above. `401` if the password is wrong. `204` on success.
  Rate-limited to 5/min.
- `GET /v1/stations` — lists active radio stations. Public, no auth.
  Optional `?countryId=`/`?genreId=`/`?languageId=` filters (combined with
  AND) and `?q=` (case-insensitive substring match against the name).
  Paginated with `?limit=` (default 50, max 100) and `?offset=`; the
  response's `pagination.total` reflects the filtered-but-unpaginated
  count.
- `GET /v1/stations/:id` — a single active station. `404` for an unknown id
  or a curated-off (inactive) one — the same response either way, see
  "Radio Master Catalog" below.
- `GET /v1/stations/ranked` — a country's active stations ranked best-first
  by recent streaming reliability (the automatic fallback chain). Public,
  no auth. Requires `?countryId=`; optional `?windowHours=` (default 24,
  max 168) and `?limit=` (default 20, max 50). See "Stream Reliability"
  below.
- `POST /v1/stations` — requires an admin account (see "Authorization: user
  roles" above). Body: `{ countryId, name, streamUrl, websiteUrl?, logoUrl?, description?, genreIds?, languageIds? }`.
  `streamUrl`/`websiteUrl`/`logoUrl` must be HTTPS. `400` on invalid input, an
  unknown `countryId`, or a `genreIds`/`languageIds` entry that doesn't
  match a real genre/language; `409` if `streamUrl` is already registered
  to another station.
- `PATCH /v1/stations/:id` — requires an admin account. All fields
  optional, including `isActive` (pulls/restores a station from the public
  catalog without deleting it). `genreIds`/`languageIds`, if present,
  *replace* the station's full tag set — omit to leave it untouched, send
  `[]` to clear it. Same `400`/`409` cases as create, `404` for an unknown
  id.
- `DELETE /v1/stations/:id` — requires an admin account. Permanently
  deletes the station (and its genre/language associations, which cascade)
  and its history — prefer `PATCH { isActive: false }` for routine
  curation. `404` for an unknown id.
- `GET /v1/admin/stations` — requires an admin account. Same filters as
  `GET /v1/stations` (`countryId`/`genreId`/`languageId`/`q`, paginated),
  plus `isActive` — omit it to see every station regardless of curation
  state (the whole point of this route), or set it to see only active or
  only inactive ones. This is the only way to see a curated-off station
  through the API at all; the public route can never be coaxed into
  showing one.
- `GET /v1/genres` — lists the genres a station can be tagged with. Public,
  no auth.
- `GET /v1/languages` — lists the languages a station can be tagged with.
  Public, no auth.
- `POST /v1/admin/stations/:id/health-check` — requires an admin account.
  Runs a real, live reachability check against the station's own
  `streamUrl` right now and records the result. See "Stream Reliability"
  below. `404` for an unknown station id.
- `GET /v1/admin/stations/:id/health-checks` — requires an admin account.
  The station's recorded health checks, most recent first (`limit`,
  default 20, max 100). `404` for an unknown station id.
- `GET /v1/admin/stations/:id/reliability` — requires an admin account.
  Computed `uptimePercentage`/`averageLatencyMs` over a recent window
  (`windowHours`, default 24, max 168). See "Stream Reliability" below.
  `404` for an unknown station id.

Full interactive API docs (OpenAPI 3, generated from the route schemas
below) are served at `/docs` outside production, or when `ENABLE_API_DOCS=true`
is set — off by default in production since this isn't a published public
API yet. Raw spec at `/docs/json`.

## Request validation

`POST /v1/users` validates its body against a JSON Schema (email format,
password length, displayName length, countryId type) rather than hand-rolled
if/else checks — Fastify rejects malformed requests before the handler ever
runs, and the same schema documents the endpoint in `/docs`. Two things stay
outside the schema deliberately:
- The bcrypt 72-byte password ceiling (JSON Schema's `maxLength` counts
  UTF-16 code units, not UTF-8 bytes, so it can't express this correctly).
- `POST /v1/auth/login`'s body has no schema at all: a schema-validation
  failure would return a different status/message than a wrong password,
  undermining the anti-enumeration behavior above. Every invalid login
  input returns the identical 401.

## Password reset

`POST /v1/auth/password-reset/request` + `POST /v1/auth/password-reset/confirm`
give an account owner a way to recover access without knowing their
current password — the one piece a "change password" endpoint alone can
never cover, since it requires the current password as proof of identity.

- **Tokens are high-entropy and hashed at rest**: `crypto.randomBytes(32)`
  (256 bits), and only a SHA-256 hash of it is stored
  (`password_reset_tokens.token_hash`) — never the raw token — so a
  database leak alone can't be replayed into an account takeover. This is
  deliberately a fast hash, not bcrypt: bcrypt's slowness defends against
  guessing a *low-entropy, user-chosen* secret, which doesn't apply to a
  256-bit random value nobody could feasibly guess or brute-force.
- **Single-use and time-limited**: a token is marked used on a successful
  reset (or superseded by requesting a new one) and expires after 1 hour.
- **No enumeration**: `request` always returns the same response whether
  or not the email is registered; `confirm` always returns the same
  generic message for any invalid/expired/used/unknown token.
- **Kills existing sessions**: `confirm` reuses the same `token_version`
  bump as `POST /v1/me/password` (see below), so a reset invalidates every
  JWT issued before it — the scenario this exists for (recovering from a
  suspected compromise) would be undermined if an attacker's existing
  session survived the reset.
- **Whitespace-tolerant**: `token` is trimmed before use (`preValidation`
  on `POST /v1/auth/password-reset/confirm`) — the raw token is always
  lowercase hex, so whitespace can never be a legitimate part of a real
  one, but a copy/paste path (an email client wrapping the link, a manual
  copy of just the token) could add some. `newPassword` is deliberately
  left untrimmed: unlike a token, a password's leading/trailing characters
  can be part of what the user actually meant to type.
- **Verified against a real database**: `tests/passwordReset.test.ts`
  covers the full flow (reset → old password dead, new password works,
  pre-reset session token dead, token can't be replayed), the
  supersede-on-request behavior (an earlier unused link stops working the
  moment a new one is requested), and a token with incidental
  leading/trailing whitespace still completing the reset successfully —
  not just input validation.

### Password reset email delivery

`POST /v1/auth/password-reset/request` sends a real password-reset email
through a transactional outbox — the same pattern used by high-volume
production systems, not a development stand-in:

- **Provider-agnostic via SMTP** (`src/email/providers/smtpEmailProvider.ts`,
  built on `nodemailer`). Any SMTP-speaking provider works —
  AWS SES, Postmark, SendGrid, Mailgun, Resend, or a corporate relay —
  by setting `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`EMAIL_FROM`
  (see `.env.example`). Switching providers later is a config change, not
  new code or a new dependency.
- **Transactional outbox** (`src/repositories/emailOutboxRepository.ts`,
  migration `1700000005000_email_outbox`). Issuing the reset token and
  enqueueing its email happen inside **one database transaction**
  (`src/routes/auth.ts`), so the two can never go out of sync — a crash
  or error between the two can never leave a valid, usable token with no
  email ever queued for it.
- **Decoupled, self-healing delivery worker**
  (`src/email/outboxWorker.ts`). A background worker polls the outbox
  (`EMAIL_OUTBOX_INTERVAL_MS`, default 10s) and sends each row
  independently — a slow or down email provider can never make the
  `/auth/password-reset/request` request itself hang or fail. A failed
  send goes back to `pending` for the next poll to retry, up to 5
  attempts, then lands in `failed` (a dead letter — inspectable, never
  silently dropped).
- **Safe concurrent claiming.** The worker claims a batch via
  `FOR UPDATE SKIP LOCKED` inside a CTE, so running more than one worker
  instance (horizontal scaling) can never double-send the same email —
  correct from day one, not a "someday" concern.
- **Dev-safe default.** With no `SMTP_HOST` configured, `createEmailProvider()`
  (`src/email/provider.ts`) falls back to `ConsoleEmailProvider`, which logs
  the email instead of sending it, and logs a loud warning every time it's
  selected — so a missing production SMTP config is impossible to miss
  silently, but local development and CI need zero email setup.

**Before a production launch**, an operator must provision a real SMTP
account (a provider, a sending domain with SPF/DKIM/DMARC configured for
deliverability) and set the `SMTP_*`/`EMAIL_FROM` env vars — that account
and domain reputation is outside what code can set up. Until then the app
runs correctly end-to-end using the console provider, exactly as verified
in `tests/emailOutbox.test.ts` and `tests/passwordReset.test.ts`.

## Token invalidation on password change

JWTs are stateless: a valid signature only proves a token was legitimately
issued at some point, not that nothing has changed since. Without more,
changing a password wouldn't actually revoke a token an attacker had
already stolen — it would stay valid until its natural 7-day expiry
regardless, defeating the point of the password change as a security
response.

`users.token_version` (migration `1700000003000_users_token_version`)
closes that gap. Login embeds the account's current `token_version` in the
JWT as `tv`. `POST /v1/me/password` atomically bumps `token_version` in the
same statement as the password update (so the two can never drift out of
sync from a partial failure). `app.authenticate` compares a token's `tv`
against the account's current value on every request and rejects a
mismatch with `401` — so every token issued before a password change stops
working immediately, not "eventually." A token signed without a `tv` claim
(none in current production use, but true of hand-signed tokens in tests)
skips the check rather than failing closed, and a `token_version` lookup
for an account that no longer exists is left to the route's own lookup to
produce its usual `404`, not folded into this check as a `401`.

Verified end-to-end against a real database in
`tests/tokenVersion.test.ts`: a token used to change the password is
rejected immediately afterward, a fresh login's token keeps working, and a
deleted account's token still gets a clean `404` rather than getting
confused with a version mismatch.

## Authorization: user roles

Every account has a `role` (`'user'` or `'admin'`, migration
`1700000006000_users_role`), surfaced in `user.role` on registration,
login, and `GET /v1/me` so a client can conditionally show admin UI. It's
never client-settable: `POST /v1/users`'s schema strips any `role` field a
request body tries to send (same `additionalProperties: false` mechanism
covered in "Request validation" above), and there is no endpoint that lets
an account set its own or anyone else's role.

- **The only way to become an admin right now is `ADMIN_EMAILS`** (see
  `.env.example`), a comma-separated allowlist checked on both
  registration and every login (`ensureBootstrapAdminRole` in
  `src/repositories/usersRepository.ts`). There's no admin-management
  endpoint yet — that's the Admin Dashboard (Steps 31–33) — so this
  config-driven "break-glass" bootstrap is what makes admin-gated routes
  reachable at all before then. It's deliberately **one-way**: removing an
  email from `ADMIN_EMAILS` never demotes an existing admin — an operator
  typo here must never silently lock out the only admin account. Real
  demotion is a future admin-management concern.
- **`app.requireAdmin`** (`src/app.ts`) is the guard a route adds to gate
  itself to admins: `preHandler: [app.authenticate, app.requireAdmin]`
  (in that order — it reads `request.user`, which only `authenticate`
  populates). `POST /v1/stations`, `PATCH /v1/stations/:id`, and
  `DELETE /v1/stations/:id` are its first real callers (see "Radio Master
  Catalog" below); Events moderation and the Admin Dashboard will add more.
- **The role is looked up fresh from the database on every request** —
  deliberately *not* embedded in the JWT. A token doesn't carry a `role`
  claim at all, so there's nothing to go stale: promoting or demoting an
  account takes effect on that account's very next request, not whenever
  its current token happens to expire (up to `JWT_EXPIRES_IN`, 7 days by
  default) or get reissued. The one extra query this costs is on an
  admin-gated path, not the general request volume.

Verified end-to-end against a real database in `tests/adminRole.test.ts`:
an `ADMIN_EMAILS`-listed email is promoted through the real registration
and login routes (not just the repository function in isolation); an
unlisted email registers as `'user'`; a client-supplied `role: "admin"` in
a registration body is silently stripped; and — registering a temporary
test-only route guarded by `[app.authenticate, app.requireAdmin]` since no
production route exists yet — an unauthenticated request gets `401`, an
authenticated non-admin gets `403`, an authenticated admin gets `200`, and
promoting/demoting an account via `setUserRole` takes effect on the very
next request using the *same, already-issued* token in both directions.

## Radio Master Catalog

`radio_stations` (migration `1700000007000_radio_stations`) is the core
table behind Steps 12–18. Per the Project Standard, it only ever stores a
station's *metadata* and its own authorized `streamUrl` — a listener's
device connects to that URL directly; this backend never proxies, records,
or rebroadcasts the audio itself, so there's deliberately no audio-storage
column here at all.

- **Public reads, admin-gated writes.** `GET /v1/stations` and
  `GET /v1/stations/:id` need no auth. `POST`/`PATCH`/`DELETE` and
  `GET /v1/admin/stations` require `[app.authenticate, app.requireAdmin]`
  (see "Authorization" above) — the catalog is curated, not user-editable.
- **Full curation visibility is a structurally separate route, not a query
  param on the public one.** `GET /v1/admin/stations` (Step 15) is the
  only place an inactive/curated-off station is visible through the API
  at all — closing a real gap the public route's own design deliberately
  left open (its `isActive` filter is always `true` and never
  client-controlled, so there was previously no way for even an admin to
  browse what had been curated off, other than a direct database query).
- **HTTPS-only stream and website URLs**, enforced by JSON Schema
  (`pattern: "^https://"`, not just `format: "uri"`, which checks general
  URI structure but not scheme) — the same HTTPS-end-to-end standard the
  API holds itself to, and what iOS's App Transport Security already
  requires of a direct connection from a listener's device.
- **`streamUrl` is unique at the database level**, not just checked in
  application code — a duplicate registration is rejected with `409`
  before it can ever land two rows pointing at the same stream. Step 16
  (below) layers near-duplicate detection on top of this exact-match
  guarantee.
- **Soft-disable via `isActive`, not just delete.** `PATCH { isActive: false }`
  pulls a station from `GET /v1/stations` and turns `GET /v1/stations/:id`
  into a `404` — identical to the 404 for an id that never existed, so the
  public API never leaks "this exists but is hidden" — while keeping the
  row and its history intact for curation (Step 17). `DELETE` is for
  removing a genuine mistake, not routine curation.
- **Admin-only fields can't be set by the client.** `additionalProperties: false`
  strips anything outside the documented body (the same
  `removeAdditional: true` behavior already relied on for `POST /v1/users`),
  and there's no field a request body could use to set a station's id,
  timestamps, or which admin created it.
- **`name`/`description`/`streamUrl`/`websiteUrl` are trimmed of
  leading/trailing whitespace** on both create and update, before schema
  validation runs — a `preValidation` hook, the same mechanism
  `POST /v1/users`/`PATCH /v1/me` already use for `email`/`displayName`.
  Found missing here during an audit (this route was built after those and
  the same input-hygiene hook was never carried over) and fixed: a
  genuinely valid `streamUrl` with copy-pasted surrounding whitespace was
  being rejected outright by the HTTPS `pattern` check, rather than the
  whitespace being silently stored, and an all-whitespace `name` now
  correctly fails its `minLength: 1` check instead of creating a
  blank-looking station.

Verified end-to-end against a real database in `tests/stations.test.ts`:
full create → read → update → deactivate (removed from public listing and
detail) → delete lifecycle with a real admin account; `401`/`403` for a
missing/non-admin token on every write; `409` for a duplicate `streamUrl`;
`400` for an unknown `countryId`; `404` for an unknown station id on read,
update, and delete; and a client-supplied unknown field silently stripped
rather than rejected or persisted.

### Genres and languages (Step 13)

`genres` and `languages` (migration `1700000008000_genres_and_languages`,
seeded by `1700000008500_seed_genres_and_languages`) are database-driven
lookup tables — the same "seed a starter set, add more later without a
code change" shape as `countries` — rather than a hardcoded enum, listed
publicly at `GET /v1/genres` and `GET /v1/languages`. A station can carry
more than one of each (`station_genres`/`station_languages`, many-to-many
junction tables): several of the 13 launch countries are functionally
bilingual on-air (Saint Lucia and Dominica's French Creole alongside
English, Puerto Rico's Spanish and English), and a station is rarely
"only" one genre.

- **A single round trip, not N+1.** Fetching a station's tags uses two
  independent correlated subqueries with `json_agg` (one for genres, one
  for languages) rather than joining both junction tables directly into
  the main query — joining two separate one-to-many relations at once
  would fan a station with, say, 2 genres and 3 languages out into 6
  duplicated rows before any aggregation could run. `COALESCE(..., '[]')`
  means "no tags" is an empty array, never a `null` a client has to guard
  against.
- **`genreIds`/`languageIds` replace the full set, not merge into it.**
  `PATCH { genreIds: [3] }` on a station currently tagged `[1, 2]` leaves
  it tagged only `[3]` — simpler and unambiguous compared to diffing an
  add/remove list, and matches the write volume an admin-curated catalog
  actually sees. Omit the field to leave existing tags untouched; send
  `[]` to clear them.
- **An unknown id is a `400`, not a silent no-op or a `500`.** Both are
  enforced by the junction tables' own foreign keys — the same "database
  constraint, not just application code" posture as `streamUrl`'s
  uniqueness above — and the write path distinguishes *which* one failed
  (genre vs. language vs. country) from the failing constraint's name to
  return the right message rather than a generic one.
- **Deleting a station cascades.** `ON DELETE CASCADE` on both junction
  tables means a deleted station's tag associations are gone with it —
  never an orphaned row a future genre/language listing could trip over.

Verified end-to-end against a real database in
`tests/genresAndLanguages.test.ts` (public listing, seeded content) and
`tests/stations.test.ts` (create/read with hydrated genre and language
objects, not just echoed ids; full-set replacement, untouched-when-omitted,
and cleared-with-`[]` on update; `400` for an unknown genre or language id;
a duplicate id within the same request tolerated rather than erroring; and
a deleted station's junction rows confirmed gone via a direct query).

### Search, filtering, and pagination (Step 14)

`GET /v1/stations` combines four independent narrowing mechanisms, all
`AND`ed together when given at once: `countryId`, `genreId`, `languageId`
(each an `EXISTS` subquery against the relevant table/junction, so it never
duplicates a row the way a direct `JOIN` on two separate one-to-many
relations would), and `q` (a case-insensitive `ILIKE` substring match
against the station name — plain `ILIKE`, not a full-text index, which
would be premature complexity for a curated catalog on the order of dozens
to a few hundred stations rather than a large free-text corpus).

- **Every response is paginated**, never an unbounded "return everything."
  `limit` defaults to 50 and is capped at 100 — enforced both in the route's
  JSON Schema (a request over the cap is a clean `400`) and again inside
  `listStations` itself, so a future internal caller that reaches the
  repository directly (an admin tool, a background job) can't trigger an
  unbounded scan just by forgetting to apply that same schema.
- **`pagination.total` is the filtered-but-unpaginated count**, computed
  with `COUNT(*) OVER()` in the same query as the page of results rather
  than a second round-trip with a separately-maintained `WHERE` clause —
  one query, and the count can never drift out of sync with what actually
  matched.
- **A literal `%` or `_` in a search term is escaped before being bound as
  the `ILIKE` pattern**, so a search for a station whose name genuinely
  contains one of those characters doesn't have it misread as a SQL
  wildcard. This was never a SQL-injection concern either way (the term is
  always a bound parameter, never concatenated into the query string) —
  purely about search results matching what the user actually typed.

Verified end-to-end against a real database in `tests/stations.test.ts`:
a case-insensitive substring search that finds a real station and excludes
unrelated ones; a literal `%` in a search term matching nothing (proving
the escape works, not just the happy path); `genreId`/`languageId` filters
applied independently and in combination (including a combination that
matches nothing, proving `AND` semantics rather than `OR`); and a full
`limit`/`offset` pagination walk across two pages with an exact, stable
`pagination.total` throughout. `tests/stations.validation.test.ts` covers
every rejected shape: non-integer `genreId`/`languageId`, `limit` of `0`,
negative, or over 100, a negative `offset`, and an empty or over-length `q`.

### Admin station listing (Step 15)

`listStations`'s filter gained a genuine tri-state `isActive` (undefined =
no filter at all, `true`/`false` = exactly that state) in place of the
previous plain `activeOnly` boolean, which could only ever mean "active
only" or "no filter" — there was no way to ask for *only* the inactive
ones. `GET /v1/stations` still always passes `true` explicitly and never
lets a client override it; `GET /v1/admin/stations` (admin-only) is what
exposes the real filter, alongside the same `countryId`/`genreId`/
`languageId`/`q`/pagination support as the public route.

This closes a real, previously-flagged gap, not a hypothetical one: before
this route existed, an admin who deactivated a station (or wanted to
review what had been curated off, or find a station that mysteriously
stopped appearing publicly) had no way to do it through the API at all —
only a direct database query would show an inactive row. `is_active` is
also now bound as a real query parameter in the underlying SQL rather than
a hardcoded `true` literal string, closing that small inconsistency with
every other filter in the same query.

Verified end-to-end against a real database in `tests/stations.test.ts`:
`401`/`403` for a missing/non-admin token; a station deactivated via
`PATCH` confirmed invisible on the public route but visible (and correctly
found/excluded by `isActive=true`/`isActive=false`) on the admin route; the
same `countryId`/`genreId`/`q`/pagination filters working identically to
the public route; and the same unknown-field-stripped-not-rejected
behavior already established elsewhere, verified here too rather than
assumed to carry over.

### Data quality: near-duplicate stream URLs (Step 16)

Step 12's exact-match `stream_url` `UNIQUE` constraint only ever caught a
byte-for-byte repeat of a URL already in the catalog. Two admin-typed URLs
that are the *same stream* in every way that matters —
`https://Stream.Example.com/live` vs. `https://stream.example.com/live`, or
a bare `https://stream.example.com` vs. `https://stream.example.com/` —
would both pass that check and silently create two catalog rows for one
station. `normalizeStreamUrl` (`src/utils/streamUrlValidation.ts`)
case-folds the scheme and host (case-insensitive per RFC 3986 §3.1/§3.2.2),
folds away an explicit default `:443` port, and folds a bare trailing slash
on the *root* path only — a longer path's trailing slash is left alone,
since real Icecast/Shoutcast-style stream servers can route `/stream` and
`/stream/` to different mount points, so treating that as a duplicate would
be a false positive, not a real one. Path (beyond the root case) and query
string stay case-sensitive and untouched, since both can be genuinely
meaningful to a stream server.

The normalized form is stored in `stream_url_normalized`
(migrations `1700000009000_radio_stations_stream_url_normalized` +
`1700000009500_backfill_stream_url_normalized`, split into two files for
the same reason Step 02's countries and Step 13's genre/language seed were:
`pgm.addColumn` is deferred schema DSL that only actually runs once a
migration function returns, so an immediate `pgm.db.query` backfill in the
*same* migration would run against a table that, as far as the database is
concerned, doesn't have the column yet) with its own `UNIQUE` constraint —
the database itself enforces this, not just application code a future
direct caller could bypass, the identical defense-in-depth reasoning
already applied to `stream_url` itself. A violation of this constraint is
reported as `NearDuplicateStreamUrlError` (409, a distinct message from the
exact-match `DuplicateStreamUrlError`) so an admin can tell the two cases
apart instead of getting an ambiguous "already registered."

Verified: a full migration up/down/up cycle on both the dev and test
databases; `tests/streamUrlValidation.test.ts` unit-tests
`normalizeStreamUrl` directly (host case-folding without touching path
case, default-port folding, root-only trailing-slash folding, query strings
preserved, and a malformed-URL fallback); `tests/stations.test.ts` proves
the real end-to-end behavior against Postgres — a host-case variant and a
root-path trailing-slash variant of an existing station's `streamUrl` both
rejected with `409` and the near-duplicate message on `POST`, the same
rejection on `PATCH` when updating one station's `streamUrl` to a
near-duplicate of *another* station's, a byte-for-byte repeat still getting
the original exact-duplicate message (not swallowed by the new check), and
re-saving a station's own unchanged `streamUrl` correctly succeeding (no
false-positive self-conflict). Proven to actually catch the bug, not just
pass by construction: temporarily made `createStation`/`updateStation`
write the raw (non-normalized) `streamUrl` into the normalized column,
watched the three new near-duplicate tests fail with the exact wrong status
code (`201`/`200` instead of `409`), then restored the fix and watched the
full 139-test suite pass three consecutive runs; `npm audit` clean.

### Curation: deactivation audit trail (Step 17)

`is_active` (Step 12) already let an admin pull a station from the public
catalog without deleting it, but recorded nothing about *why* or *by
whom*. Reviewing a deactivated station months later — or once Steps 19–23's
automated stream-reliability monitoring starts deactivating stations on its
own — gave no way to tell "a human decided this was a duplicate" from "the
stream has been down all week" apart from separately remembering it.

`PATCH /v1/stations/:id` with `isActive: false` now also accepts an
optional `deactivationReason` (trimmed like every other free-text field)
and always records `deactivatedAt`/`deactivatedByUserId` automatically —
the acting admin's id, taken from their own token, never client-suppliable
independently of actually performing the deactivation. `deactivationReason`
is rejected with `400` if sent without `isActive: false` in the same
request — a cross-field rule enforced in the route handler rather than
JSON Schema, since "field A only valid alongside field B's exact value"
isn't a plain per-property schema constraint. Reactivating
(`isActive: true`) clears all three fields — a reason for being inactive
stops applying once a station is active again, so leaving a stale reason
behind on reactivation would be actively misleading, not just unused data.
Migration `1700000010000_radio_stations_deactivation_audit` is a single,
unsplit `pgm.addColumn` (all three columns nullable, no backfill needed —
an existing row simply getting `NULL` *is* the correct "never deactivated"
state), so the deferred-DDL-vs-immediate-`pgm.db.query` hazard documented
in `docs/BUILD_MANIFEST.md` (hit for Steps 02, 13, and 16) doesn't apply
here at all.

All three fields are exposed on the shared `stationSchema` response (not a
separate admin-only shape) — safe to do since the public routes only ever
return `isActive: true` stations, where these are trivially always `null`;
the real curation-state visibility already lives structurally behind
`GET /v1/admin/stations` (Step 15), not behind which fields a schema lists.

Verified: migration up/down/up on dev and test databases; the full
144-test suite (5 new) passing three consecutive runs; `npm audit` clean;
proven to actually catch the bug (not pass by construction) by temporarily
reverting to the pre-Step-17 route/repository/schema code and watching all
5 new tests fail with the exact wrong values (`undefined` where an actor id
or reason was expected, `200` where the cross-field rule should reject with
`400`) before restoring the fix. Covers: actor/timestamp recorded and a
reason stored on deactivation; deactivation without a reason leaving
`deactivationReason` `null` rather than some placeholder; reactivation
clearing all three fields; the `400` for `deactivationReason` sent without
`isActive: false` (both "omitted entirely" and "explicitly `true`"); the
same whitespace-trimming guarantee as every other free-text field; and the
audit trail visible end-to-end through `GET /v1/admin/stations`.

### Station logo/artwork metadata (Step 18)

The last piece of the Caribbean Radio Master Catalog bucket (Steps 12–18)
before Stream Reliability (19–23). This document's Front-End Design
Direction already names "station logos/artwork" as media the client has to
handle correctly (proper codecs/formats, responsive sizing) — `logoUrl` is
the metadata column that content actually comes from, so the catalog's
data model is complete before any client work needs it.

`logoUrl` is optional and validated/trimmed exactly like `websiteUrl` —
HTTPS-only via the same `HTTPS_URL_SCHEMA`, the same `preValidation` trim
hook — a deliberate consistency choice rather than a new pattern for one
field. Unlike `streamUrl`, it carries no uniqueness constraint: more than
one station legitimately sharing the same (e.g. default/placeholder)
artwork is normal, not the kind of data-quality problem a duplicated
stream endpoint is. Migration `1700000011000_radio_stations_logo_url` is a
single, unsplit `pgm.addColumn` (nullable, no backfill needed — an
existing row getting `NULL` correctly means "no artwork set yet") —
checked against the deferred-DDL-vs-immediate-`pgm.db.query` hazard (hit
for Steps 02, 13, 16) and confirmed it doesn't apply here, the same
due diligence already applied to Step 17's audit columns.

Verified: migration up/down/up on dev and test databases; the full
151-test suite (7 new, split between real-DB behavior in
`tests/stations.test.ts` and schema-only rejection in
`tests/stations.validation.test.ts`) passing three consecutive runs;
`npm audit` clean; proven to actually catch a real gap by temporarily
reverting to the pre-Step-18 route/repository/schema code and watching the
new tests fail before restoring the fix. Covers: `logoUrl` accepted and
returned hydrated on create; defaults to `null` when omitted; updatable via
`PATCH`; whitespace trimmed like every other free-text field; and schema
rejection of a non-HTTPS or malformed `logoUrl` on both `POST` and `PATCH`.

## Stream Reliability

The Caribbean Radio Master Catalog (Steps 12–18, above) stores what a
station *is* - its metadata and its own authorized `streamUrl`. Stream
Reliability (Steps 19–23) is about whether that URL actually works right
now, which the catalog alone can never answer: a listener's device
connecting to a dead stream is a different failure than a wrong URL, and
this project's standing "automatically rank stations per country by actual
streaming quality, with fallback to the next-best" requirement needs a
real, measured history to rank against, not an assumption.

### Health checks (Step 19)

`checkStreamHealth` (`src/utils/streamHealthCheck.ts`) makes a real, live
`GET` request directly to a station's own `streamUrl` - never a proxy,
never a cached copy, the same no-rebroadcast rule the Project Standard
already holds the rest of this API to. The one thing that makes this
different from every other outbound request in this codebase: a live radio
stream can send audio *forever*, so reading its response body to
completion (or even letting it finish on its own) would never return. The
response body is cancelled immediately once headers arrive, before any
audio data is read, releasing the connection without downloading a single
byte of the actual stream. A configurable timeout (default 8s) covers a
stalled/hung server that accepts a connection but never responds at all.

Storage: `station_health_checks` (migration `1700000012000`, one row per
check, `FK ... ON DELETE CASCADE` to `radio_stations`, indexed on
`(station_id, checked_at)` for the "this station's history, most recent
first" pattern everything downstream needs) and
`stationHealthRepository.ts` (`recordHealthCheck`, `listHealthChecks` -
capped at 100 per call like every other list endpoint in this catalog).

Exposed now, not left as backend-only plumbing until a later step:

- `POST /v1/admin/stations/:id/health-check` - runs one check immediately
  and records it. Works against an inactive/curated-off station too (an
  admin deciding whether to reactivate one needs to check it first) -
  `404` only for a genuinely unknown station id.
- `GET /v1/admin/stations/:id/health-checks?limit=` - the recorded
  history, most recent first.

Both admin-only (`[app.authenticate, app.requireAdmin]`), the same gating
as every other station-catalog write - triggering a real outbound network
request on the caller's behalf is not something any authenticated user
should be able to do.

Automatic, recurring checks across the whole catalog on a schedule are
Step 20, below - this step is the manual-trigger primitive everything else
builds on, proven to work end-to-end before anything gets automated on top
of it.

Verified with real due diligence, not mocks: `tests/streamHealthCheck.test.ts`
runs the check function against real local HTTP servers - a genuinely
infinite-streaming one (proving the cancel-the-body approach actually
avoids downloading forever: the whole 5-test file finishes in about half a
second despite one server that would happily stream indefinitely), a
`404`, a server that accepts the connection but never responds (proving
the timeout), a real connection-refused, and a malformed URL.
`tests/stationHealth.test.ts` exercises the real routes end-to-end against
a real database and real network calls - `401`/`403`/`404` gating, a
genuinely reachable local server recorded correctly, a genuinely refused
connection recorded correctly, history ordering, and the limit cap.
Proven to actually catch a gap, not just pass by construction: temporarily
un-registered the new routes in `app.ts` and watched 8 of the 10 new route
tests fail with `404` before restoring the registration. A live-server run
confirmed the same against two genuinely different real endpoints - an
unreachable real domain (a real DNS/connection failure, not a simulated
one) and a real local server stood up specifically to be reached - both
recorded correctly, with the history endpoint returning both in the right
order.

### Automatic health checks (Step 20)

The background counterpart to Step 19's manual trigger, and what actually
makes "that day's" reliability signal real rather than something an admin
has to remember to ask for. `startHealthCheckWorker`
(`src/stationHealth/healthCheckWorker.ts`) is started and gracefully
stopped alongside the HTTP server and the existing email outbox worker in
`index.ts` — the identical lifecycle pattern: an `unref()`'d interval, a
returned stop function called on `SIGINT`/`SIGTERM`.

The worker is deliberately two layers, not one:

- **`sweepStations(targets)`** — the actual logic. Concurrency-limited (5
  at a time, a small fixed worker pool pulling from a shared index — no new
  dependency needed for something this simple), so a growing catalog can
  never fire hundreds of simultaneous outbound requests at once. Guarded
  against overlap: a module-level flag means a slow sweep can never run
  concurrently with the next scheduled tick, so the same station never gets
  double-checked at once. Each station's own database-write failure is
  isolated (caught and logged) so it can never stop the rest of the sweep.
- **`runHealthCheckSweep()`** — a one-line composition of `sweepStations`
  with `listActiveStationsForHealthCheck` (`stationsRepository.ts`), a new,
  deliberately lightweight query: id and `streamUrl` only, no genre/
  language joins or pagination overhead, active stations only (an
  inactive/curated-off station doesn't need automatic monitoring — an admin
  can still check one manually via Step 19's endpoint, which never filters
  on `isActive`).

New config: `STATION_HEALTH_CHECK_INTERVAL_MS` (default 5 minutes) —
deliberately much longer than the email outbox's 10-second poll, since
every tick makes a real outbound request to a real third-party server and
this needs to be a good network citizen, not just fast.

**Found and fixed during this step's own test-writing, not hypothetically:**
the first version of the worker's test called `runHealthCheckSweep()`
directly against the real, shared local test database — which, per Step
18's own finding, has accumulated well over a thousand stations across
this build's repeated local test runs — and the test genuinely timed out
sweeping all of them. Root-caused immediately this time (recognized the
same class of issue on sight, not rediscovered slowly) and fixed by the
`sweepStations`/`runHealthCheckSweep` split described above, so tests
exercise the real concurrency/overlap/error-isolation logic against a
small, controlled target list without ever depending on the shared
catalog's size — the identical lesson as Step 18's fix, this time applied
proactively to new code instead of reactively to a failure.

Verified: clean build and lint; the full 170-test suite
(`tests/healthCheckWorker.test.ts`, 4 new) passing three consecutive runs;
`npm audit` clean; proven to actually catch a bug, not just pass by
construction, by temporarily disabling the overlap guard and the
active-only filter and watching the exact two tests that check those
behaviors fail (2 concurrent checks recorded instead of 1; an inactive
station included instead of excluded) before restoring both; and a
live-server run with a shortened interval
(`STATION_HEALTH_CHECK_INTERVAL_MS=3000`) confirming a station that was
never manually checked accumulated automatic health-check records entirely
on its own within a few seconds, with no admin action at all.

### Reliability scoring (Step 21)

Steps 19–20 only ever produced individual, point-in-time check rows; the
per-country quality ranking (Step 22) needs one comparable number per
station, computed from recent history — "that day's" signal, not a static
one-time ordering.

`getStationReliability` (`stationHealthRepository.ts`) aggregates a
station's checks over a configurable recent window (default 24h — matching
"that day's" from the ranking requirement's own wording; capped at a week)
into:

- **`uptimePercentage`** — reachable checks ÷ total checks in the window.
- **`averageLatencyMs`** — averaged across *reachable* checks only. An
  unreachable check's `latencyMs` measures how long it took to fail, not
  how fast a working stream responds — mixing the two in would distort the
  signal, not add to it.

Both are `null`, not `0`, when there's no data to compute them from (zero
checks in the window, or zero reachable ones for the latency average) — a
station with no history must never rank identically to one with a
confirmed 0% track record. A station that's been checked and found down
every single time correctly gets a real `0`, never `null`.

Exposed as `GET /v1/admin/stations/:id/reliability?windowHours=`
(admin-gated, `404` for an unknown station id) rather than left as
backend-only plumbing — a complete, independently testable vertical slice
before Step 22 builds the actual ranking on top of it. No migration needed:
this reuses Step 19's `station_health_checks` table entirely.

Verified: clean build and lint; the full 177-test suite (7 new) passing
three consecutive runs; `npm audit` clean; proven to actually catch two
real bugs by temporarily (a) collapsing the null-vs-`0` distinction for
`uptimePercentage` and (b) removing the reachable-only filter from the
latency average (so a timed-out check's multi-second "latency" pollutes
the reachable-stream signal), watching the exact three tests that check
those behaviors fail with precisely the wrong values, then restoring both;
and a live-server run confirming a station with zero checks returns
`null`/`null`, and the same station after three real checks against a
genuinely unreachable domain correctly shows `0`% uptime (not `null`) with
`averageLatencyMs` still `null`.

### Per-country ranking (Step 22)

The actual feature this document's "Radio Station Quality Ranking"
describes: for each country, stations ranked best-first by real, measured
reliability, so a client can try `stations[0]` and automatically fall
through to the next entry if it fails to play. Public, unauthenticated
(`GET /v1/stations/ranked?countryId=&windowHours=&limit=`) — this is a
production listening-client feature, not an admin tool.

`getRankedStationReliabilityForCountry` (`stationHealthRepository.ts`) is
one aggregation query per country — not one query per station, which would
only get worse as a country's catalog grows — that computes and orders by
the ranking rule in a single `ORDER BY`: known reliability beats unknown,
highest uptime first, lower average latency breaks a tie, station name
breaks any remaining tie for full determinism.

**The unknown-station placement is a deliberate, reasoned choice:** a
station with zero recorded checks could be broken (a `streamUrl` typo,
wrong port, anything Step 20's automatic sweep just hasn't caught yet) just
as easily as it could be fine — so it ranks *after* every station this
system has actually verified, even one with a confirmed-mediocre track
record. Trusting measured evidence over no evidence at all, not assuming
the best of an unverified stream.

`stationRankingRepository.ts` (`getRankedStationsForCountry`) combines that
ranking query with a new bulk `findStationsByIds` (`stationsRepository.ts`
— one hydration round trip for the whole ranked set, re-sorted back into
rank order since Postgres's `ANY($1)` makes no ordering guarantee), so each
response entry carries the full station object paired with the reliability
figures that placed it there — not a bare id list a client would have to
look up separately.

Registered as a static route (`/stations/ranked`), not a sub-path of
`/stations/:id` — verified live, not assumed safe from routing theory
alone, that an id-less request correctly hits this route's own querystring
validation (`400`, missing `countryId`) rather than ever being captured by
the `:id` route's integer check.

**Found and fixed a second real test-isolation gap during this step's own
test-writing** (the same class Steps 18/20 already hit, recognized
immediately this time): ranking has no `q=` marker to scope a test to just
its own rows — it's inherently "every active station in a country" — so
the first version of these tests picked an unused launch country to dodge
every *other* test file's accumulated pollution. Correct, but incomplete:
this file's own repeated local runs would just as surely re-pollute those
same countries over time. Fixed by hard-deleting every station a test
creates in `afterEach` (cascading to its health checks) — both fixes
together (avoid others' pollution, clean up your own), not either alone.

Verified: clean build and lint; the full 188-test suite (11 new) passing
three consecutive runs, including running the new file back-to-back twice
locally specifically to prove the `afterEach` cleanup actually prevents
self-accumulation, not just assumed to; `npm audit` clean; proven to
actually catch two real bugs by temporarily (a) flipping `NULLS LAST` to
`NULLS FIRST` in the ranking order and (b) dropping the `country_id` filter
from the ranking query entirely, watching 8 of the 11 tests fail (the query
broke outright rather than subtly misordering — an even louder signal)
before restoring both; and a live-server run with three real stations
(measured 100% uptime, measured 0% uptime, never-checked) in a country
untouched by any other test data, confirming the exact ranked order the
design intends, plus confirming live that `/v1/stations/ranked` and
`/v1/stations/:id` never shadow each other.

## Security baseline

- **Security headers**: `@fastify/helmet` is registered globally (CSP, HSTS,
  X-Content-Type-Options, X-Frame-Options, etc.).
- **Rate limiting**: `@fastify/rate-limit` caps the API at 100 req/min per
  client by default; `POST /v1/users` has its own tighter limit (5/min) since
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
- **JWT algorithm is explicitly pinned to HS256** (`app.ts`, both `sign` and
  `verify`), not left to the library's default of accepting any of
  HS256/HS384/HS512 for a plain secret key. A forged token can't pick its
  own verification algorithm via its header — standard JWT hardening
  (OWASP's JWT cheat sheet), verified in `tests/authenticate.test.ts`.
- **Every `fast-jwt` verification failure is a 401**, not just the 4 out of
  ~15 failure codes `@fastify/jwt` itself wraps into a proper-401 error —
  see "Adversarial security pass" below for how this was found.
- **No email enumeration via login**: see `POST /v1/auth/login` above.

### Adversarial security pass

Beyond the per-step due diligence above, this backend has been directly
attacked by its own builder — not just reviewed — against a live running
server: JWT forgery (`alg: none`, invalid/nonsense `alg` headers, weak-secret
signature guessing, oversized tokens), auth/authz bypass attempts (missing
tokens, cross-role privilege escalation, mass-assignment of `role` via
`PATCH /v1/me`), SQL injection through every class of input (email, station
name, query params, path params), rate-limit brute-forcing, CORS/header
inspection, and error-response leakage (stack traces, sensitive fields,
`passwordHash`) on 404s and malformed bodies.

One real, non-hypothetical finding came out of it: a forged token with an
invalid `alg` header returned `500` instead of `401`. Root cause:
`@fastify/jwt` only converts 4 of `fast-jwt`'s ~15 verification-failure
codes into a proper-401 `FastifyError`; everything else (including an
invalid algorithm — the classic `alg: none` forgery vector) passed through
as a raw error with no `statusCode`, falling through this app's generic
error handler to its `500` default. The token was still correctly
*rejected* either way — this was never an auth bypass — but a hostile,
malformed request was being misclassified as the server's own bug (logged
at `error`, not `warn`). Fixed in `app.ts`'s `setErrorHandler` by
recognizing any `FAST_JWT_*` error code as a `401` regardless of whether
the library remembered to attach a `statusCode`; locked in with a
regression test in `tests/authenticate.test.ts`, proven to fail against the
pre-fix code (reverted the fix, watched both new tests fail with the exact
`500`, restored it) the same way every other regression fix in this build
has been proven, not just asserted.

Everything else held: no SQL injection anywhere (parameterized queries
throughout — a payload like `'); DROP TABLE radio_stations;--` in a station
name round-trips as inert stored data, verified against the real table
afterward), no privilege escalation (role changes require an admin account
and can't be set by any request body), no sensitive data ever appears in a
response, no stack traces or internal detail leak on any error path, and
rate limiting is enforced under an actual brute-force burst, not just
configured.

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

Tests use Fastify's `inject()` so most HTTP-layer tests do not require a
running server or database — validation-only cases fail before ever
reaching the DB. `tests/tokenVersion.test.ts` is the exception: it
exercises the real token-invalidation-on-password-change flow end-to-end
against a real database, since that's exactly the kind of bug that a
mocked/validation-only test can't catch. It needs a migrated
`caribbean_radio_hub_test` database locally (CI already gets an
equivalent via its own migrated service container, so nothing extra is
needed there):

```bash
createdb -U caribbean -h localhost caribbean_radio_hub_test
DATABASE_URL=postgres://caribbean:caribbean@localhost:5432/caribbean_radio_hub_test npm run migrate:up
```

**This local test database is never truncated between runs.** Repeated
local `npm test` invocations accumulate real rows in it indefinitely (CI is
unaffected — its Postgres service container is freshly migrated on every
run). A test that checks "does the catalog's listing contain the station I
just created" must therefore never do so against an *unfiltered*,
default-paginated query — that assumption silently breaks once enough
local runs push the relevant country/name past
`DEFAULT_STATION_LIST_LIMIT`, exactly the bug found and fixed during Step
18 (a Step 12-era test, still passing for a long time by accident). The
correct pattern, already used throughout `tests/stations.test.ts`: give the
row a name/marker unique to that test invocation and filter the listing
query by it (`q=<marker>`), so the assertion holds regardless of how much
unrelated historical data has piled up. Match on what a test actually
created, not on a shared real resource's total state — the same fix
already applied once for `email_outbox` (Step 09) and now for
`radio_stations` (Step 18).

## CI

`.github/workflows/backend-ci.yml` runs on every push/PR touching
`backend/**`: install, build, lint, migrate a real Postgres service
container, run the full test suite, and `npm audit --audit-level=high`
(fails the build on a high/critical vulnerability) — the same sequence
manually verified by hand at every step so far, now enforced automatically
on every future change rather than relying on remembering to run it.
