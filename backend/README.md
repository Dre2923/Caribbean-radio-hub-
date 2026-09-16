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
- `GET /v1/admin/users` — requires an admin account. Optional `?q=`
  (case-insensitive substring match against email or displayName) and
  `?role=` (narrow to exactly `user`/`admin` — omit for every account).
  Paginated with `?limit=` (default 50, max 100) and `?offset=`. See
  "Admin user management" above.
- `GET /v1/admin/users/:id` — requires an admin account. `404` for an
  unknown id.
- `PATCH /v1/admin/users/:id` — requires an admin account. Body:
  `{ role: "user" | "admin" }`. `404` for an unknown id, `409` if this
  would demote the last remaining admin (including an admin demoting
  themselves) — see "Admin user management" above.
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
- `GET /v1/events` — lists approved events. Public, no auth. Optional
  `?countryId=`/`?categoryId=` filters (combined with AND), `?q=`
  (case-insensitive substring match against the title), and
  `?startsAfter=`/`?startsBefore=` (an inclusive date-time range against
  `startsAt`). Excludes an event that has already concluded by default —
  pass `?includePast=true` to see those too. `?nearLatitude=`/
  `?nearLongitude=` (both required together) restrict results to events
  that have coordinates and switch the ordering to nearest-first, adding a
  `distanceKm` to each result; optional `?radiusKm=` further caps results
  to that great-circle distance (requires both coordinates too). Paginated
  with `?limit=` (default 50, max 100) and `?offset=`; ordered
  soonest-first by `startsAt`, or nearest-first when a proximity search is
  in effect. See "Events" below.
- `GET /v1/events/:id` — a single approved event. `404` for an unknown id
  or a pending/rejected one — the same response either way, the identical
  no-leaking-moderation-state reasoning as a curated-off station's `404`.
- `POST /v1/events` — requires authentication (any account, not just
  admin — see "Events" below). Body:
  `{ countryId, title, description?, venue?, venueAddress?, latitude?, longitude?, startsAt, endsAt?, imageUrl?, ticketUrl?, categoryIds? }`.
  `imageUrl`/`ticketUrl` must be HTTPS; `latitude`/`longitude` must both be
  present together and each within its real-world range. The resulting
  event's `status` is never client-controlled: a regular user's submission
  starts `pending` (hidden from the public routes above until an admin
  approves it); an admin's own submission is `approved` immediately. `400`
  on invalid input, an unknown `countryId`, an unknown `categoryIds`
  entry, `endsAt` not after `startsAt`, or a lone `latitude`/`longitude`
  without its pair. `409` if an event with the same title already exists
  for this country and start time.
- `PATCH /v1/events/:id` — requires an admin account. All fields optional,
  including `venueAddress`/`latitude`/`longitude` (subject to the same
  both-or-neither/range rules as creation). This is also how moderation
  happens: `{ status: "approved" }` or `{ status: "rejected" }` on a
  pending submission — the same "curation is just another PATCH-able
  field" pattern as `radio_stations.isActive`. May include an optional
  `moderationReason` (only valid together with `status`) — the acting
  admin and a timestamp are recorded automatically either way.
  `categoryIds`, if present, *replaces* the event's full category set —
  omit to leave it untouched, send `[]` to clear it. `404` for an unknown
  id, `409` if the update (e.g. a renamed `title`) would collide with
  another existing event's title/country/start time.
- `DELETE /v1/events/:id` — requires an admin account. Permanently deletes
  the event — prefer `PATCH { status: "rejected" }` for routine moderation.
  `404` for an unknown id.
- `GET /v1/admin/events` — requires an admin account. The moderation
  queue: same `?countryId=`/`?categoryId=`/`?q=`/`?startsAfter=`/
  `?startsBefore=`/`?nearLatitude=`/`?nearLongitude=`/`?radiusKm=` filters
  as `GET /v1/events`, plus `?status=` to narrow to exactly
  `pending`/`approved`/`rejected` (omit to see every submission regardless
  of moderation state) and `?upcomingOnly=true` to narrow to events that
  haven't concluded yet (omit to see both past and upcoming — unlike the
  public route, this never excludes a concluded event by default).
- `GET /v1/event-categories` — lists the categories an event can be tagged
  with. Public, no auth.
- `POST /v1/voice/command` — requires authentication. Body: `{ text }`, a
  transcribed voice command (speech-to-text happens client-side — no
  audio ever reaches this endpoint). Returns a resolved intent
  (`play_station`/`play_ranked`/`playback_control`/`ambiguous`/
  `not_found`/`unrecognized`) plus whatever data that intent needs. Always
  `200` for a well-formed request, even an unrecognized command — see
  "Voice System" below. `400` only for a missing/empty `text`.
- `GET /v1/me/favorites/stations` — requires authentication. Lists the
  caller's favorited stations, most-recently-favorited first. Paginated
  with `?limit=` (default 50, max 100) and `?offset=`. See "User Features"
  below.
- `PUT /v1/me/favorites/stations/:stationId` — requires authentication.
  Favorites a station for the caller. Idempotent — favoriting an
  already-favorited station succeeds with no error. `404` for an unknown
  or curated-off (inactive) station — the same response either way as
  `GET /v1/stations/:id`.
- `DELETE /v1/me/favorites/stations/:stationId` — requires authentication.
  Un-favorites a station for the caller. Idempotent — succeeds whether or
  not it was favorited, or even still exists.
- `GET /v1/me/favorites/events` — requires authentication. Lists the
  caller's favorited events, most-recently-favorited first. Same
  pagination as the stations equivalent.
- `PUT /v1/me/favorites/events/:eventId` — requires authentication.
  Favorites an event for the caller. Idempotent. `404` for an unknown,
  pending, or rejected event — the same response either way as
  `GET /v1/events/:id`.
- `DELETE /v1/me/favorites/events/:eventId` — requires authentication.
  Un-favorites an event for the caller. Idempotent.
- `POST /v1/me/listening-history` — requires authentication. Body:
  `{ stationId }`. Records that the caller just listened to a station —
  entirely client-reported, since the backend holds no server-side "now
  playing" state. `400` for an unknown `stationId`. `listenedAt` is always
  the server's own current time.
- `GET /v1/me/listening-history` — requires authentication. Lists the
  caller's listening history, most-recently-listened first. Same
  pagination as favorites. Unlike favorites, a deactivated station still
  appears (this is a historical record, not an actionable list); a
  hard-deleted station appears with `station: null`.
- `DELETE /v1/me/listening-history` — requires authentication. Permanently
  clears the caller's entire listening history.
- `POST /v1/me/push-tokens` — requires authentication. Body:
  `{ token, platform }` (`platform` is `android`/`ios`/`windows`).
  Registers a device push token for the caller. Idempotent — registering a
  token that's already known overwrites its owner/platform rather than
  erroring, since a device can be re-registered on refresh or under a
  different account. See "User Features" below.
- `GET /v1/me/push-tokens` — requires authentication. Lists the caller's
  registered devices, most-recently-refreshed first. Same pagination as
  favorites/listening-history.
- `DELETE /v1/me/push-tokens` — requires authentication. Body:
  `{ token }`. Un-registers a device push token for the caller (e.g. on
  logout). Idempotent.
- `GET /v1/me/notification-preferences` — requires authentication. Returns
  the caller's notification preferences (currently one:
  `favoriteStationAvailabilityChanges`, default `true`). See "User
  Features" below.
- `PATCH /v1/me/notification-preferences` — requires authentication. Body:
  `{ favoriteStationAvailabilityChanges? }`, at least one field. Updates
  only the fields present.

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

- **The very first admin is always `ADMIN_EMAILS`** (see `.env.example`),
  a comma-separated allowlist checked on both registration and every login
  (`ensureBootstrapAdminRole` in `src/repositories/usersRepository.ts`) —
  the config-driven "break-glass" bootstrap that makes admin-gated routes
  reachable at all on a brand-new deployment with no admin account yet.
  It's deliberately **one-way**: removing an email from `ADMIN_EMAILS`
  never demotes an existing admin — an operator typo here must never
  silently lock out the only admin account.
- **Every subsequent role change goes through `PATCH /v1/admin/users/:id`**
  (Step 31 — see "Admin user management" below), a real admin-management
  endpoint. Both paths funnel through the same `setUserRole`, so the same
  audit trail and last-admin protection apply either way.
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

### Admin user management (Step 31)

The first step of the Admin Dashboard bucket (Steps 31-33), and a real gap
found during the Steps 27-64 architecture research
(`docs/ARCHITECTURE_PLAN.md`): before this, `setUserRole`/`getUserRole`
existed only as repository functions, reachable solely through the
`ADMIN_EMAILS` bootstrap allowlist above, with no API surface for a human
admin to list accounts or manage roles at all — a real dashboard needs
user management alongside the station/event moderation this build already
had.

- `GET /v1/admin/users` / `GET /v1/admin/users/:id` / `PATCH
  /v1/admin/users/:id` — see the Endpoints list below for the full
  request/response shape.
- **Role changes are audited.** `users` gained `role_changed_at`/
  `role_changed_by_user_id` (migration `1700000018000_users_role_change_audit`)
  — the identical audit-trail shape already established for
  `radio_stations.deactivated_at`/`by` (Step 17) and
  `events.moderated_at`/`by` (Step 27). `role_changed_by_user_id` stays
  `null` for the automated `ADMIN_EMAILS` bootstrap promotion (no human
  admin acted — the same "`null` means the system did this" convention as
  `radio_stations`' Step 19-23 automated deactivation) while
  `role_changed_at` is still set, so an admin can tell "the system
  bootstrapped this account" from "another admin explicitly promoted it."
- **The last remaining admin can never be demoted — not even by
  themselves.** `setUserRole` locks every current admin row
  (`SELECT ... FOR UPDATE`) before checking whether the target is the sole
  admin, so two concurrent demotion requests can't both read "someone else
  is still an admin" and each proceed — closing off a permanent-lockout
  scenario outright rather than relying on client-side care. Rejected with
  `409`.

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

### Automatic deactivation (Step 23)

The last step of the Stream Reliability bucket, closing the loop between
Step 21's reliability scoring and Step 17's curation audit trail. Steps
19–22 all treat an unreliable station as something to route *around* — the
ranking already puts it last — but none of them ever stop it from
cluttering the public catalog indefinitely. A station confirmed completely
dead for days now gets curated off automatically instead of waiting for an
admin to notice.

Deliberately conservative on two axes, so an automated system can never
mistake a brief outage for a dead station:

- A **48-hour window** — double Step 21's 24h "that day" default. Two full
  days of nothing but failure, not one bad day.
- A **minimum sample floor** (20 checks) — a handful of failures during a
  deploy window or a DNS blip must never be enough evidence on their own.
- Acts only on an **exact 0% uptime**, never "mostly down."

`updateStation`'s `actorUserId` parameter widened from `number` to
`number | null` — Step 17 made `deactivated_by_user_id` nullable
specifically to support a non-human actor, and this is that actor. An
admin scanning `GET /v1/admin/stations?isActive=false` can tell an
automatic deactivation apart from a manual one purely by whether that
field is null, with zero new endpoints or flags needed.

`evaluateStationsForAutoDeactivation`/`runAutoDeactivationSweep`
(`src/stationHealth/autoDeactivationWorker.ts`) mirror Step 20's
`sweepStations`/`runHealthCheckSweep` split exactly, overlap guard
included — and for the identical reason, recognized proactively this time
rather than discovered via a timeout: a real full-catalog evaluation would
be slow and non-deterministic to test directly against the shared,
ever-growing local test database, so tests exercise the
given-a-list function instead. Started/stopped alongside the other two
background workers in `index.ts`. New `STATION_AUTO_DEACTIVATION_INTERVAL_MS`
config (default 1 hour) — the 48h decision only meaningfully changes as
check history accumulates, so re-running it every 5 minutes like the
health-check sweep would just repeat the same query for no new
information. No migration needed — reuses Step 17's nullable columns and
Step 21's reliability query.

Verified: clean build and lint; the full 197-test suite (9 new — a
pure-unit block for the decision rule plus real-DB integration tests)
passing three consecutive runs; `npm audit` clean; proven to actually
catch a real bug by temporarily dropping the minimum-check-count guard from
the decision rule and watching both the unit test and the integration test
that check it fail with the exact wrong values before restoring it; and a
live-server run with a shortened interval creating a real station, giving
it 25 real failed health checks, and watching it go from a normal `200`
public response to a `404` entirely on its own within seconds — with the
admin view confirming `deactivatedByUserId: null` and a self-explanatory
`deactivationReason` naming the exact check count and window.

**The Stream Reliability bucket (Steps 19–23) is complete**: real,
live reachability checking (19), automated on a schedule (20), aggregated
into a comparable reliability score (21), turned into the actual
per-country fallback-chain ranking (22), and now closing the loop by
curating off what's confirmed dead (23).

## Events

### Events core and moderation (Step 24)

The first step of the Events Database bucket (Steps 24–30), and the
foundational table everything else in it builds on — the same shape
Step 12 played for the Radio Master Catalog.

Events differ from radio stations in the one way that shapes this table
from the start: **any authenticated user can submit an event**, not just
an admin. A submission needs a real moderation lifecycle, not just an
`isActive` on/off switch.

`events` (migration `1700000013000_events`): `country_id` (FK), `title`,
`description`, `venue`, `starts_at`/`ends_at` (only `starts_at` required —
a DB `CHECK` enforces `ends_at > starts_at` whenever both are present; a
`NULL ends_at` always satisfies it), `image_url`/`ticket_url` (HTTPS-only,
validated at the application layer exactly like `radio_stations.logo_url`/
`stream_url` — ticket purchase is always an external link, this API never
handles payment, matching the Project Standard's "connect directly, don't
intermediate" philosophy), `status` (`pending`/`approved`/`rejected`, DB
`CHECK`-constrained, defaults to `pending`), and an audit-trail
`created_by_user_id` (`SET NULL` on the account's deletion, same reasoning
as `radio_stations.created_by_user_id`).

The moderation lifecycle, end to end:

- `POST /v1/events` requires only authentication — deliberately *not*
  admin-gated, unlike every other write in the Radio Master Catalog. The
  resulting `status` is derived server-side from the submitter's role (a
  fresh `getUserRole` lookup, the same pattern `app.requireAdmin` already
  uses): a regular user's submission starts `pending`; an admin's own
  submission is auto-approved immediately (the same trust level every
  other admin-gated write already has, so an admin never has to
  self-moderate). A client-supplied `status` field is never trusted
  either way — `createEventBodySchema`'s `additionalProperties: false`
  silently strips it before the handler ever sees it (Fastify's
  `removeAdditional: true`, the same well-established behavior already
  relied on for `POST /v1/users`).
- `GET /v1/events`/`GET /v1/events/:id` are public and always restricted
  to `status: 'approved'` — never client-controlled. An unknown id and a
  pending/rejected one 404 identically, so the public API never leaks
  moderation state to anyone probing ids (the same reasoning as a
  curated-off station's `404`).
- `PATCH /v1/events/:id` is admin-only, and moderation itself is just
  `PATCH { status: 'approved' | 'rejected' }` on a pending submission —
  the identical "curation is just another PATCH-able field" pattern
  already established for `radio_stations.isActive`, not a dedicated pair
  of approve/reject endpoints.
- `DELETE /v1/events/:id` is admin-only, reserved for a genuine mistake
  or spam — prefer `PATCH { status: 'rejected' }` for routine moderation,
  which keeps the row (and its history) rather than deleting it.
- `GET /v1/admin/events` is the moderation queue: full visibility across
  every status, with an optional `?status=` filter to narrow to exactly
  one. Folded into this step itself, unlike the equivalent
  station-admin-listing route (deferred to Step 15) — without it, the
  moderation loop a regular user's submission depends on would be
  entirely non-functional, not just incomplete.

`GET /v1/events` orders soonest-first by `startsAt` rather than
alphabetically like stations — "what's coming up" is what an events
listing is actually for.

Checked against both standing hazards from the start:

- The migration uses only deferred schema-DSL calls (`createTable`/
  `addConstraint`/`createIndex`, no `pgm.db.query`), so it isn't subject
  to the deferred-DDL-vs-immediate-query hazard (see "Database access
  patterns" below).
- `GET /v1/events` has no `q=`/search filter to scope a test to just its
  own rows — the same shape of gap Steps 18/20/22 already hit against the
  shared, never-truncated local test database. `tests/events.test.ts`
  reuses Step 22's isolated-country-plus-`afterEach`-hard-deletion
  pattern, adapted to two *fixed* isolated country indices shared across
  the whole file (there are only 13 seeded launch countries — not enough
  for one-per-test across this file's ~20 tests) rather than a fresh one
  per test. Safe specifically because `afterEach` unconditionally clears
  every event the file creates before the next test runs, so each test
  still starts from a genuinely empty slate in both countries regardless
  of reuse.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 218-test suite (21 new in `tests/events.test.ts`)
passing three consecutive runs; `npm audit` clean; proven to actually
catch two real bugs by temporarily (a) hardcoding a submission's status to
`approved` regardless of the submitter's role and (b) removing the
pending/rejected check from the public detail route, and watching the
exact tests that check those behaviors fail with the precise wrong
status/status-code values before restoring both; and a live-server run
walking the full moderation loop end-to-end against real HTTP requests —
a regular user's submission is `404` publicly and hidden from the public
list, an admin sees it in the moderation queue, `PATCH { status: 'approved' }`
flips it, and it's then `200`/present in the public list, all against a
running compiled server rather than only `app.inject()`.

### Event categories (Step 25)

The second step of the Events Database bucket, mirroring Step 13's
genres/languages for the Radio Master Catalog exactly, including the
reasoning: a database-driven lookup table (seed a starter set, add more
later without a code change) rather than a hardcoded enum, since the
actual mix of event types this platform hosts is exactly the kind of
thing curators will keep expanding. Many-to-many (`event_categories` +
junction table `event_category_assignments`), not a column on `events` —
an event is rarely "only" one category (a Carnival event is often also a
Concert).

`event_category_assignments` uses a composite primary key on
`(event_id, category_id)` — the pair *is* the whole fact, and it doubles
as the uniqueness constraint — with `CASCADE` on both sides, the identical
shape as `station_genres`/`station_languages`. Seeded with a
representative starter set: Carnival, Festival, Concert, Cultural,
Community, Sports, Nightlife, Food & Drink, Family, Religious, Comedy,
Theatre & Arts (migration `1700000014000_event_categories` +
`1700000014500_seed_event_categories` — the seed data lives in a separate
migration for the same deferred-DDL-vs-immediate-query reason as every
other seeded lookup table in this codebase).

`GET /v1/event-categories` is a direct mirror of `GET /v1/genres`. Every
event response now includes a hydrated `categories` array (a `json_agg`
subquery in `EVENT_SELECT`, identical in shape to `STATION_SELECT`'s
genres/languages subqueries — a direct `JOIN` would fan an event with N
categories out into N duplicated rows before aggregation could run).
`POST`/`PATCH /v1/events/:id` accept an optional `categoryIds`, following
the exact same three-way convention already established for
`radio_stations`' `genreIds`/`languageIds`: omit it to leave associations
untouched, send `[]` to clear them, send a non-empty array to replace the
full set. An unknown `categoryIds` entry is a `400`
(`InvalidEventCategoryError`, detected the same way as stations'
`InvalidGenreError`/`InvalidLanguageError` — a foreign-key violation's
constraint name). `GET /v1/events`/`GET /v1/admin/events` gained a
`?categoryId=` filter, an `EXISTS` subquery against the junction table —
the identical pattern as `stationsRepository.listStations`'s
`genreId`/`languageId` filters.

Making a categories-touching update atomic (the event row and its
junction-table rows must commit together) meant widening `updateEvent`
from a plain pooled query to `withTransaction` — previously a single
`UPDATE` statement was already atomic on its own, but a `categoryIds`
replacement is now a second statement that has to succeed or fail with
it.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 225-test suite (7 new) passing three consecutive
runs; `npm audit` clean; proven to actually catch two real bugs by
temporarily (a) skipping the DELETE half of the category-replace helper
whenever the incoming array is empty (so `PATCH { categoryIds: [] }`
silently failed to clear) and (b) disabling the `categoryId` `EXISTS`
filter entirely, and watching the exact tests that check those behaviors
fail with the precise wrong category lists before restoring both; and a
live-server run creating a real event with two categories, confirming
they're hydrated on create, filtering correctly narrows
`GET /v1/events?categoryId=`, `PATCH` both replaces the full set and
(with `[]`) clears it, a `PATCH` touching only `title` leaves categories
untouched, and an unknown `categoryId` is rejected with `400`.

### Event search and date-range filtering (Step 26)

The third step of the Events Database bucket, mirroring Step 14's
search/filtering/pagination for the Radio Master Catalog, adapted for
what an events listing actually needs.

`q` is a case-insensitive substring match against `title` — the identical
`ILIKE`/`escapeLikePattern` pattern as `stationsRepository.listStations`'s
`search` filter, ported into `eventsRepository.ts` (station search
matches `name`; the analogous identifying field for an event is `title`).

`startsAfter`/`startsBefore` is the genuinely new piece, with no station
analog: an inclusive date-time range against `starts_at` — "what's
happening this weekend" is exactly the query an events listing needs to
answer that a radio catalog never did. A reversed range (`startsAfter`
after `startsBefore`) isn't unsafe — it just silently produces an
always-empty result, almost certainly a client mistake rather than an
intentional query — so a `validDateRange` cross-field check in
`routes/events.ts` returns a real `400` before the request ever reaches
the repository, the same "route around the actual confusion instead of a
technically-correct empty list" spirit as `PATCH /v1/stations/:id`'s
`deactivationReason`/`isActive` cross-field check.

Both filters apply identically to `GET /v1/events` and
`GET /v1/admin/events`, composing with every existing filter (`countryId`,
`categoryId`, `status`) via `AND` — exactly like every filter this listing
has gained so far. No migration needed: this is pure application-layer
query logic, the same "no schema change" shape as Step 21.

Verified: clean build and lint (no migration to cycle this step); the
full 229-test suite (4 new) passing three consecutive runs; `npm audit`
clean; proven to actually catch two real bugs by temporarily (a)
disabling the title `ILIKE` filter entirely and (b) changing the
`startsBefore` bound from inclusive (`<=`) to exclusive (`<`), and
watching the exact tests that check those behaviors fail with the precise
wrong event lists (an untargeted extra event returned; an exact-boundary
event silently dropped) before restoring both; and a live-server run with
two real events ("Live Jazz Night" starting soon, "Reggae Sunset Fest"
starting later) confirming `q=jazz`/`q=fest` each isolate the right one
case-insensitively, `startsAfter`/`startsBefore` each isolate the correct
side of the boundary, a reversed range is rejected with `400`, and the
admin listing honors the same `q`+`startsBefore` combination together
with its own `status` filter.

### Event moderation audit trail (Step 27)

The fourth step of the Events Database bucket, mirroring Step 17's
`radio_stations` deactivation audit exactly. Step 24's `status` already
lets an admin approve/reject a submission, but recorded nothing about who
decided, when, or why.

Added `moderated_at`/`moderated_by_user_id`/`moderation_reason`, all
nullable, all populated only as a side effect of a real status decision —
never independently editable:

- An admin's own submission is auto-approved at creation (Step 24) — that
  auto-approval *is* the moderation decision, made by the same admin, so
  it's recorded as one right away rather than left looking unmoderated
  just because it happened at creation time rather than a later `PATCH`.
- A regular user's submission stays fully unmoderated (all three `null`)
  until an admin's `PATCH` actually decides its `status` — which records
  that `PATCH`'s own actor, timestamp, and optional `moderationReason`
  (only valid together with `status` in the same request — the identical
  cross-field rule as `radio_stations`' `deactivationReason`/`isActive`).

Attribution is recorded on every status write, not scoped to only an
actual pending→approved/rejected transition — re-affirming an
already-decided status is still an admin action worth attributing, the
same reasoning `updateStation` already applies to `deactivated_by_user_id`.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 235-test suite (6 new) passing three consecutive
runs; `npm audit` clean; proven to actually catch two real bugs by
temporarily (a) dropping the moderator-attribution from the `PATCH`
status branch and (b) hardcoding the creation-time self-moderation to
`null`, and watching the exact tests that check each attribution path
fail with the precise wrong (`null`) value before restoring both; and a
live-server run confirming an admin's own submission self-moderates, a
regular user's submission stays unmoderated, a later admin approval
records that admin and a timestamp, a rejection can carry a
`moderationReason`, that reason is rejected with `400` without `status`,
and a title-only edit afterward leaves the moderation record untouched.

### Duplicate event detection (Step 28)

The fifth step of the Events Database bucket, mirroring Step 16's
near-duplicate stream URL detection for the identical reason it existed
there: an event is hand-typed by any authenticated user (not just an
admin), so the same real-world happening being submitted twice with only
cosmetic title differences is a genuine, expected failure mode.

Added `title_normalized` (trim + collapse internal whitespace + lowercase
— the same modest, deliberately-bounded philosophy as
`normalizeStreamUrl`: case only, no fuzzy matching) and a **partial**
unique index on `(country_id, title_normalized, starts_at)` scoped to
`WHERE status <> 'rejected'` — partial, not a plain table-wide `UNIQUE`,
so a submission an admin already rejected never permanently blocks a
legitimate resubmission from reusing the same title/time. Deliberately
exact-match on the normalized triple, not a fuzzy time-window heuristic
("within 2 hours") — that would risk false positives between two
genuinely different events that happen to share a title, which an exact
timestamp match cannot. A new `DuplicateEventError` (`409`) applies
uniformly to `POST /v1/events` and `PATCH /v1/events/:id` — a rename that
collides with another existing event is caught the same way a create is.

**Found and fixed a real test-pollution incident during this step's own
regression-proofing** — not a bug in the shipped code or the permanent
test suite, but a gap in the regression-proof method itself: the first
version of two duplicate-detection tests used a raw `app.inject` call
(not the cleanup-tracked `createEventViaApi` helper) for the second,
expected-to-fail submission. When the deliberately-injected bug made that
call unexpectedly succeed, nothing tracked the resulting real row for
`afterEach` cleanup, leaving it orphaned in the shared test database after
the bug was restored. Cleaned it up, then hardened both tests to use
`createEventViaApi` for that call, and re-verified live that the same
injected bug still gets caught **and** now cleans up after itself.
Generalizing this going forward: any regression-proof that could make an
assertion-of-rejection unexpectedly succeed must use the same
cleanup-tracked helper the rest of that test file already uses for its
real submissions — the identical vigilance already standing for the
deferred-DDL and test-pollution hazard classes, now extended to the
regression-proofing process itself.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 241-test suite (6 new) passing three consecutive
runs both before and after the pollution cleanup; `npm audit` clean;
proven to actually catch two real bugs by temporarily (a) removing the
whitespace-collapse step from title normalization and (b) corrupting the
constraint-name string the duplicate-detection error mapping matches
against, and watching the exact tests that check those behaviors fail
with the precise wrong values (a near-duplicate slipping through as
`201`; a real duplicate surfacing as an unmapped `500` instead of `409`)
before restoring both; and a live-server run confirming an exact
re-submission and a case/whitespace near-duplicate both `409`, a
title/time freed up by rejecting the original resubmits cleanly as `201`,
and the same title at a different time or in a different country is
never flagged.

### Excluding concluded events by default (Step 29)

The sixth step of the Events Database bucket, closing a real UX gap the
listing has had since Step 24: without any time-based filtering, an event
that already happened would sit in `GET /v1/events` forever, cluttering a
"what's happening" default view with stale results.

Filters on `COALESCE(ends_at, starts_at) >= now()` — an event with no
announced end time is judged by its start alone; one with both is judged
"over" only once its actual end has passed, so a multi-day event that
started in the past but hasn't ended yet correctly stays "upcoming."

A deliberate, reasoned **departure** from the `isActive`/`status`
precedent, not an inconsistency: those are moderation/curation-state
concepts the public route hard-codes and never exposes at all, but
"upcoming vs. past" is a legitimate temporal view a real client wants
control over (a "past events" tab is normal for an events app) — so
`GET /v1/events` defaults to excluding a concluded event but lets the
caller opt in with `?includePast=true`, while `GET /v1/admin/events`
exposes `?upcomingOnly=` as a genuine, undefaulted filter (a moderator
reviewing the queue needs to see a concluded event too — e.g. one
submitted and rejected after the fact).

No migration needed: this is pure application-layer query logic, the
same "no schema change" shape as Steps 21/26.

Verified: clean build and lint (no migration to cycle this step); the
full 246-test suite (5 new) passing three consecutive runs; `npm audit`
clean; proven to actually catch two real bugs by temporarily (a)
narrowing the `COALESCE` condition to `starts_at` alone and (b)
hardcoding the public route's time filter to always show everything
regardless of `includePast`, and watching the exact tests that check
those behaviors fail with the precise wrong event lists (an ongoing
multi-day event wrongly excluded; a concluded event wrongly included by
default) before restoring both; and a live-server run with one concluded
and one upcoming event confirming the public route's default excludes
the concluded one, `includePast=true` includes both, the admin queue
shows both by default, and `upcomingOnly=true` narrows it to just what's
still ahead.

### Event location and proximity search (Step 30)

The seventh and final step of the Events Database bucket, completing the
core data model before Admin Dashboard/Voice/Client work (Steps 31+)
builds on top of it. `venue` (since Step 24) is only a free-text name
("National Stadium") — nothing a map view or a "near me" search could act
on. Adds `venueAddress` (a fuller street/city address, distinct from and
complementary to the venue name), and optional `latitude`/`longitude`
(migration `1700000017000_events_location`, `addColumn`-only — an
existing row simply gets `NULL` across all three, the correct "no
structured location given yet" state, so there's no backfill and no
deferred-DDL-vs-immediate-query ordering question to navigate this time).

Coordinates are constrained at the database level, not just the
application layer, per the "assume every input is hostile" standard: a
`CHECK` (`events_location_lat_long_together`) enforces both-or-neither (a
lone coordinate is meaningless and would silently corrupt a distance
calculation), and two more (`events_latitude_range`/
`events_longitude_range`) enforce each stays within its real-world range
— all three re-verified independently by the JSON Schema layer
(`LATITUDE_SCHEMA`/`LONGITUDE_SCHEMA`, matching ranges) so an invalid
request is rejected with a precise `400` before ever reaching the
database, with the `CHECK` violation (`InvalidLocationError`) as the
authoritative backstop for anything the schema layer can't express (a
partial update leaving one of the pair stale, for instance).

`GET /v1/events`/`GET /v1/admin/events` gained `?nearLatitude=`/
`?nearLongitude=` (both required together — a lone one is a `400`, the
same cross-field-validation pattern as `PATCH /v1/events/:id`'s
`moderationReason`/`status`) and optional `?radiusKm=` (requires both
coordinates too). Chose the Haversine great-circle formula computed
directly in SQL over adding PostGIS: a distance-ordered "near me" list is
a modest, well-bounded feature that doesn't warrant a heavy geospatial
extension dependency, matching the free/open-source-first, no-overengineering
standard applied throughout this build. The formula's cosine-sum is
clamped into `[-1, 1]` with `LEAST`/`GREATEST` before `acos()` — floating-point
rounding can otherwise push it fractionally outside that domain for two
very close or near-antipodal points, which would otherwise make `acos()`
return `NaN` instead of `~0`. A proximity search restricts results to
events that actually have coordinates (one without them is neither
included nor excluded by `radiusKm` — it's simply not a candidate),
overrides the default soonest-first ordering with nearest-first (the same
"a specific view overrides the default sort" pattern as
`GET /v1/stations/ranked`'s reliability ordering), and populates each
result's `distanceKm` — `null` on every other listing, since "distance
from where" is meaningless outside a proximity search.

Verified: migration up/down/up on dev and test DBs; clean build and
lint; the full 258-test suite (12 new) passing three consecutive runs;
`npm audit` clean; proven to actually catch two real bugs by temporarily
(a) removing the `latitude IS NOT NULL AND longitude IS NOT NULL`
condition and watching an event with no coordinates wrongly appear in a
proximity search's results, and (b) removing the `radiusKm`-without-a-center
rejection from `validNearLocationParams` and watching both the public and
admin routes wrongly accept it as `200` instead of `400`, in both cases
restoring immediately after and confirming a byte-identical diff against
the pre-bug backup; and a live-server run with four real events (one
central, one ~10km away, one ~100km away, one with no coordinates at all)
confirming a proximity search returns nearest-first with accurate
distances, excludes the coordinate-less event, `radiusKm=50` correctly
caps to just the two nearer events, both `nearLatitude` without
`nearLongitude` and `radiusKm` without a center correctly `400` on both
the public and admin routes, and a create attempt with only one
coordinate correctly `400`s with `InvalidLocationError`'s message — all
live-server data deleted afterward.

This closes out the Events Database bucket (Steps 24-30): events now
have full moderation lifecycle, categories, search/date filtering, a
duplicate-detection safeguard, a default "what's upcoming" view, and
structured/proximity-searchable location — the same "complete a bucket's
core data model before building the UI/voice/client layers on top of it"
shape as Stream Reliability (Steps 19-23) before it.

## Voice System

`POST /v1/voice/command` (Step 34, the first of the Voice System bucket,
Steps 34-38) is the entire backend surface this feature needs. Per
`docs/ARCHITECTURE_PLAN.md`'s architecture research (sourced, not
assumed): on-device speech-to-text is the correct low-latency
architecture — a cloud STT round-trip adds 50–500ms on top of inference
time, which on-device processing eliminates entirely. That means the
backend never receives raw audio and needs no paid STT provider
credential at all; the eventual Flutter client transcribes speech
on-device and sends only the resulting **text**. This endpoint is the
complete "intent-out" half of that split: text in, a structured command
result out.

- **Requires authentication** (`app.authenticate`, any account) — not
  because a resolved intent is sensitive, but because a genre-only
  command ("play reggae") is personalized to the caller's own profile
  `countryId` (the same field `PATCH /v1/me` already exposes), which
  requires knowing who's asking. A command that already names a country
  ("play reggae in Jamaica") doesn't need this at all.
- **Rate-limited to 30/min (Step 36)** — tighter than the API's global
  100/min (`app.ts`). This is the most database-query-heavy single
  endpoint in the API (up to four real queries per call: countries,
  genres/categories, the station/event search itself, then the ranking or
  listing query), and unlike a login/registration attempt there's no
  inherent cap on how many distinct phrases an abusive script could throw
  at it. 30/min is still generous for genuine conversational use (one
  command every two seconds).
- **Every resolved command is logged with its `intent` (never the raw
  transcribed `text`) via `request.log.info` (Step 36)** — a real,
  endpoint-specific observability gap this route's own design otherwise
  creates: it deliberately never returns a non-`2xx` status for a command
  it merely failed to understand (`not_found`/`ambiguous`/`unrecognized`
  are all `200`s), so the standard HTTP access log's status code can
  never surface a command-grammar coverage problem the way it would for
  almost every other endpoint in this API. The raw `text` is deliberately
  never logged by default — it's user-generated speech content, not
  something to casually persist.
- **Never fails on unrecognized input.** Every call returns `200` with a
  `message`-carrying `intent` (`not_found`/`ambiguous`/`unrecognized`)
  instead of a `4xx` — genuinely malformed/garbled speech-to-text output
  is the expected common case for this endpoint, not an error condition
  to reject. Only a structurally invalid request body (missing/empty
  `text`) is `400`.
- **A deterministic, keyword/phrase-based resolver
  (`src/voice/commandResolver.ts`), not a machine-learning NLU
  dependency.** A real, defensible v1 for a domain this bounded: a finite
  command grammar (play by station name, play a genre in a country, five
  playback verbs) resolved against this app's own small, real
  vocabularies (12 genres, 13 countries, the station catalog) doesn't
  need — and pulling in a general-purpose NLU library or a paid cloud NLU
  API to classify roughly a dozen intents against a vocabulary this size
  would be solving a problem this app doesn't have, not meeting a higher
  standard.
- **Country/genre name matching tolerates this app's own real spelling
  variation** ("St. Lucia" vs "Saint Lucia", "Trinidad" alone matching
  "Trinidad & Tobago", "the Bahamas") via light, deliberately
  narrow normalization — not a general fuzzy-matching library, just
  enough for the specific 13 country names and 12 genre names this app
  seeds. Filler words ("play music/something/radio in Jamaica") resolve
  to "no genre preference," not an unrecognized genre.
- **A station-name match always wins over a genre-only fallback** when a
  bare "play X" phrase could be read either way (e.g. a station literally
  named "... News" when the caller says "play news") — an unambiguous
  match against a real, specific, named entity is a stronger signal of
  intent than a generic category word, the same precedence a real voice
  assistant applies.
- **Playback control (pause/resume/stop/next/previous) resolves to a bare
  intent with no data** — the backend holds no server-side "now playing"
  state to act on (that's the Flutter client's own audio session, Steps
  46-50); this endpoint's only job for those five verbs is classifying
  which one was spoken, so the client acts on its own local state
  immediately.
- **Ambiguous station-name matches ask for clarification** rather than
  guessing: `GET /v1/stations`'s substring search can return more than
  one hit for a short/common phrase, and the response's `intent:
  "ambiguous"` plus `candidates` lets the client ask "which one?" instead
  of silently picking one.
- **Event search (Step 35)**: `"events in Jamaica"`, `"carnival events in
  Trinidad"`, `"carnival events"` (defaults to the caller's profile
  country, the identical personalization as a genre-only station command),
  and `"today"`/`"tomorrow"`/`"this weekend"` relative-date suffixes
  (`"events in Jamaica this weekend"`), all resolved the same
  keyword/phrase way as station commands, against this app's own event
  categories (12 seeded) rather than genres. `intent: "search_events"`
  always queries `status: "approved"`/`upcomingOnly: true` unconditionally
  — a voice command is still just another client of the public events
  listing (Steps 26/29/30), never the moderation queue, so a pending or
  rejected submission can never surface through it. The resolved
  `dateRangeStart`/`dateRangeEnd` are always echoed back (not just applied
  silently) so the client can display what range was actually searched.
  "This weekend" specifically means the Saturday-through-Sunday already
  under way if today already is one of those two days, never a week
  further out — the exact edge case a naive "next Saturday" calculation
  would get wrong on a Sunday.
- **Discoverability (Step 37)**: `"help"`, `"what can I say"`, `"what can
  you do"`, `"commands"`, and a few other exact phrasings resolve to
  `intent: "help"` with a static, categorized `helpTopics` list of
  example commands — a real gap without it, since there was otherwise no
  way for a caller to learn what the voice system can actually do short
  of trial and error. Matched by exact normalized phrase only, the same
  discipline as the playback-control verbs — a substring match would
  wrongly classify an unrelated command that merely happens to contain
  the word "help" (e.g. a station literally named "Help Radio") as a
  help request instead of resolving what it actually named.

No migration, no new schema — this is pure orchestration over
already-existing capabilities: `GET /v1/stations`'s search (Step 14) for
play-by-name, `GET /v1/stations/ranked`'s reliability ranking (Step 22)
for play-by-genre-in-country (genre filter applied in application code
over the already-ranked list so the fallback-chain order stays intact),
and the public events listing (Steps 26/29/30) for event search.

Verified (Step 34): clean build and lint (no migration to cycle this
step); the full 286-test suite (14 new) passing three consecutive runs;
`npm audit` clean; proven to actually catch two real bugs by temporarily
(a) removing the in-application genre filter over the ranked list and
watching a wrong-genre station wrongly appear in the result, and (b)
removing the "St." → "Saint " country-alias normalization and watching
"play reggae in St Lucia" wrongly fail to resolve the country at all, in
both cases restoring immediately and confirming a byte-identical diff
against the pre-bug backup; and a live-server run covering every intent -
playback control verbs, an exact station-name match, a genre-in-country
match against a real freshly-created station, that same query correctly
`not_found` before the station existed, an unresolvable country name,
disambiguating between two real stations whose names both matched a
search term, and a completely unrecognized phrase - with all live test
data deleted afterward.

Verified (Step 35): clean build and lint; the full 296-test suite (10 new
in `tests/voiceCommand.test.ts`, including a `vi.useFakeTimers({ toFake:
["Date"] })`-based test that deterministically exercises the "this
weekend on an actual Sunday" edge case rather than leaving it to chance
on whatever day the suite happens to run) passing three consecutive runs;
`npm audit` clean; proven to actually catch two real bugs by temporarily
(a) dropping the `categoryId` filter from the `listEvents` call and
watching a wrong-category event wrongly appear in the result, and (b)
removing `getThisWeekendRange`'s Sunday special-case and watching it
wrongly skip 6 days to the *next* Saturday instead of staying on the
current day, in both cases restoring immediately and confirming a
byte-identical diff against the pre-bug backup; and a live-server run
covering event search by country, by category, an unresolvable category
and an unresolvable country, a `"this weekend"` range that correctly
excluded an event outside it, a `"today"` range that correctly excluded
an event two days out, and confirmation that a regular user's own
pending submission never appeared in another account's search results -
with all live test data deleted afterward. Also found and fixed, while
running this step's own full-suite verification, a real, long-standing
test-hygiene gap unrelated to voice commands: `tests/stationHealth.test.ts`
never tracked or cleaned up the stations it created, silently
accumulating 1096 orphaned rows in the shared test database across this
build's full history until one finally collided with a later run's
OS-reused ephemeral port on `radio_stations`' `UNIQUE(stream_url)`
constraint - fixed with the same `createdStationIds` + `afterEach`
pattern already established everywhere else in this suite, after
deleting the accumulated backlog.

Verified (Step 36): clean build and lint; the full 297-test suite (1 new
- a real 31-request loop against a real app instance confirming the
first 30 succeed and the 31st is `429`, not just that the config value is
set) passing three consecutive runs; `npm audit` clean; proven to
actually catch a real bug by temporarily raising the configured limit
from 30 to 31 and watching the exact same test wrongly pass all 31
requests as `200` before restoring and confirming a byte-identical diff
against the pre-bug backup; and a live-server run sending 32 real
requests in a loop and confirming exactly the first 30 return `200` and
the last 2 return `429`, plus tailing the live server's own log output to
confirm a real request actually produces an `intent`-carrying,
`reqId`-correlated `"voice command resolved"` log line.

Verified (Step 37): clean build and lint; the full 299-test suite (2 new)
passing three consecutive runs; `npm audit` clean; proven to actually
catch a real bug by temporarily changing the help-phrase check from an
exact `Set.has()` match to a substring match and watching "play help me
radio" wrongly resolve as `intent: "help"` instead of correctly
attempting to resolve "help me radio" as a station/genre name, restoring
immediately and confirming a byte-identical diff against the pre-bug
backup; and a live-server run confirming `"help"` and `"what can I say"`
both return the same categorized topic list, `"play help me radio"`
correctly falls through to `not_found` rather than being misclassified,
and `"pause"` still resolves normally alongside the new intent.

### Voice System bucket closed (Step 38)

The fifth and final step closed the bucket with an adversarial hardening
pass across the *whole* grammar built in Steps 34-37, not just new
surface — the same "the closing step reviews and hardens everything the
bucket built" shape as the Radio Master Catalog (Step 18), Stream
Reliability (Step 23), and Events Database (Step 30) wrap-ups before it.
Ten adversarial tests probed: text at and beyond
`MAX_VOICE_COMMAND_TEXT_LENGTH`'s boundary; whitespace-only text that
passes the schema's `minLength: 1` but is empty after `.trim()`; trailing
emoji/flag decoration on a country name; a leading emoji breaking the
grammar's `^play`/`^events` anchors; embedded newlines; excess internal
whitespace; comma/punctuation-heavy phrasing; and two SQL-injection-shaped
payloads, with the underlying table's row count verified unchanged before
and after rather than merely trusted.

**Every case already resolved safely with no production-code bug found**
— a genuinely verified outcome, not a gap: parameterized queries make
injection-shaped search phrases inert by construction; `normalizeForMatch`'s
non-alphanumeric stripping combined with the country/genre/category
matchers' substring-containment fallback gives real defense-in-depth
against decorated input (confirmed directly — temporarily letting emoji
survive normalization still left the country resolving correctly via the
substring fallback alone, proving the design doesn't hinge on any single
mechanism); and JS regex's default line-boundary semantics (`.` never
matches `\n` without the `s` flag) mean malformed multi-line input simply
and safely falls through to `unrecognized` rather than crashing.

This closes the Voice System bucket (Steps 34-38): `POST /v1/voice/command`
now covers station playback (by name, by genre-in-country, with
disambiguation), the five playback-control verbs, event search (by
country/category/relative date range), a discoverability "help" intent,
dedicated rate limiting, structured intent logging, and a verified-safe
response to adversarial input — a real, defensible v1 for the entire
text-in/intent-out half of the Voice System, with the client-side
speech-to-text half correctly deferred to Steps 39-45's Flutter Client
work per `docs/ARCHITECTURE_PLAN.md`'s sourced architecture research.

Verified (Step 38): clean build and lint; the full 309-test suite (10
new) passing three consecutive runs; `npm audit` clean; regression-proofed
via `MAX_VOICE_COMMAND_TEXT_LENGTH`'s own boundary (temporarily raising it
from 500 to 600 and watching the exact 501-character boundary test
wrongly pass as `200` instead of `400`), restoring immediately and
confirming a byte-identical diff against the pre-bug backup; and a
live-server run confirming oversized text still correctly `400`s, a
SQL-injection-shaped command resolves as an inert `not_found` with the
`radio_stations` row count provably unchanged before and after, and an
emoji-decorated `"play reggae in Jamaica 🇯🇲🎵"` still correctly resolves
both the country and the genre.

## User Features

### Favorites (Step 51)

The first step of the User Features bucket (Steps 51–55), per
`docs/ARCHITECTURE_PLAN.md`'s capability boundary ("51–55 User
Features... Yes — pure backend"). Favorites is the foundational
personalization primitive the rest of the bucket (listening history,
notification preferences) builds alongside — the same "core data model
first" shape Step 12 played for the Radio Master Catalog and Step 24
played for the Events Database.

- **Two plain many-to-many junction tables**
  (`user_favorite_stations`/`user_favorite_events`, migration
  `1700000019000_user_favorites`), not one polymorphic table with a
  resource-type discriminator column — a real foreign key to the correct
  target table on each side (so the database itself validates and cascades
  correctly), the identical shape already established for
  `station_genres`/`station_languages` (Step 13) and
  `event_category_assignments` (Step 25), just between a user and a
  resource instead of between two resources. A composite primary key
  (`user_id`, `<resource>_id`) on each: the pair *is* the whole fact, it
  doubles as the uniqueness constraint, and its leading column already
  gives exactly the index shape "every favorite for this user" needs — no
  separate index required. `ON DELETE CASCADE` on both sides of both
  tables means deleting a user or a station/event never leaves an orphaned
  favorite row behind.
- **Idempotent by design, at the HTTP layer, not just the database's
  `ON CONFLICT`.** `PUT .../favorites/stations/:id` favoriting an
  already-favorited station succeeds with no error (`204`), and
  `DELETE .../favorites/stations/:id` un-favoriting one that isn't
  currently favorited — or was never favorited at all — is equally a clean
  `204`. A favorite is a simple boolean preference from the caller's own
  point of view ("is this one of mine or not"), not a resource with its
  own identity worth protecting from a duplicate-create the way a station
  or event row is; `PUT`'s own idempotent-by-definition semantics are
  exactly the right HTTP verb for "ensure this relationship exists,"
  chosen deliberately over `POST`.
- **404 for an unknown or not-currently-public target, mirroring the exact
  same visibility rule the underlying resource's own detail route already
  enforces.** Favoriting a station requires it to exist and be `isActive`
  (the identical check `GET /v1/stations/:id` performs before its own
  `404`); favoriting an event requires it to exist and be `status:
  "approved"` (the identical check `GET /v1/events/:id` performs). A
  regular user's own still-`pending` submission, or another admin's
  `rejected` one, isn't favoritable — the same "the public API never
  leaks moderation/curation state" rule applied to a personal action, not
  just a public listing.
- **A later deactivation/rejection doesn't delete the favorite — it just
  stops it from surfacing**, the same soft-state-over-hard-delete
  philosophy this build has applied to every curation-adjacent feature
  since Step 17. `listFavoriteStations`/`listFavoriteEvents`
  (`favoritesRepository.ts`) filter to `is_active = true`/`status =
  'approved'` **at the SQL level**, in the same query that computes
  `pagination.total` — not as an application-code filter applied after the
  fact, which would let the returned page and the reported total silently
  disagree. A station favorited before being curated off keeps its
  favorite row untouched (confirmed directly against the database, not
  just the API's own filtered view of it) and reappears with zero
  re-favoriting needed the moment it's reactivated.
- **Bulk-hydrated in one round trip, re-sorted back into order** — the
  identical pattern and reasoning as
  `stationRankingRepository.getRankedStationsForCountry`: the junction-table
  query already determines *which* stations/events and in *what order*
  (most-recently-favorited first); `findStationsByIds`/the new
  `findEventsByIds` (added to `eventsRepository.ts` for this step, mirroring
  `findStationsByIds` exactly) then hydrate the full objects for that id set
  in one more round trip, since Postgres's `ANY($1)` makes no ordering
  guarantee of its own.
- **Each favorite is its own wrapper object** (`{ station, favoritedAt }` /
  `{ event, favoritedAt }`, `schemas/favorites.ts`), not a `favoritedAt`
  field bolted onto the shared `stationSchema`/`eventSchema` themselves —
  those schemas are reused by every other station/event-returning endpoint
  in the API, where "when did the current caller favorite this" has no
  meaning at all. Keeping it in a dedicated wrapper means every other
  endpoint's response shape is completely untouched by this feature.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 321-test suite (12 new in `tests/favorites.test.ts`)
passing three consecutive runs; `npm audit` clean; proven to actually catch
a real bug by temporarily removing the `s.is_active = true` filter from
`listFavoriteStations`'s SQL and watching the exact test that checks a
deactivated station drops out of the list fail (a deactivated station's
favorite wrongly stayed visible) before restoring it and confirming a
byte-identical diff against the pre-bug backup; and a live-server run
against a running compiled server covering the full lifecycle for both
stations and events — `401` with no token, `404` favoriting an unknown
station, a real favorite persisting through the list, idempotent
re-favoriting, a deactivated station disappearing from the list while its
favorite row is confirmed still present via a direct database query, the
station reappearing on reactivation with no re-favoriting, idempotent
un-favoriting, and a rejected event disappearing from the events list
while its own favorite row is likewise confirmed still present — with all
live test data deleted afterward.

### Listening history (Step 52)

The second step of the User Features bucket, alongside Step 51's
favorites. The backend holds no server-side "now playing" state for any
account — the Project Standard's own no-proxy/no-rebroadcast rule (a
listener's device connects directly to a station's own stream) already
established this, and the Voice System's `playback_control` intent
documentation restates it explicitly. That means a listening-history
record only ever exists because the client itself reports "I just started
listening to this station" — there is no way for the backend to observe
this on its own.

- **A log, not a set — the opposite shape from favorites.** A user can
  (and normally will) listen to the same station many times, so
  `listening_history` (migration `1700000020000_listening_history`) is a
  plain serial-id table, not a junction table with a composite primary
  key — there's no natural "did this user listen to this station"
  uniqueness the way "did this user favorite this station" has. A
  supporting index on `(user_id, listened_at)` gives the "this user's
  history, most recent first" query every caller needs, the identical
  index shape `station_health_checks`' own `(station_id, checked_at)`
  index already established for the same access pattern (Step 19).
- **`station_id` is `ON DELETE SET NULL`, not `CASCADE` — a deliberate
  difference from every other reference table in this build**, worth
  spelling out why: a favorite (Step 51) is an *actionable* relationship
  ("this is one of my stations right now"), so it's correct for it to
  disappear along with the station it points to. A listening-history
  entry is a *historical* record ("I listened to something at 3pm
  yesterday") — that fact stays true even if the station is later
  hard-deleted (rare in this catalog; most curation is the soft `isActive`
  toggle, Step 17), so the row is preserved with a `null` station
  reference rather than erased. The identical "`SET NULL` preserves the
  historical row, `CASCADE` would erase real information" reasoning
  already applied to `radio_stations.created_by_user_id`/
  `events.createdByUserId` when the *user* side is deleted, here applied
  to the *station* side of a different table for the same underlying
  reason. `user_id` itself is still `CASCADE` — deleting an account
  removes that account's own history along with everything else it owns.
- **Shows a deactivated station, unlike the favorites list — a deliberate
  and documented divergence, not an inconsistency.** `listFavoriteStations`
  filters to `is_active = true` because a favorite is an actionable "go
  listen to this" list; `listListeningHistory` applies no such filter,
  because "you listened to this at 3pm yesterday" remains true regardless
  of whether the station is still public today. The same station id can
  therefore correctly appear in a user's history while being invisible in
  their favorites, at the same moment, for two different and equally
  correct reasons.
- **`listenedAt` is always the database's own `now()`, never
  client-supplied** — `POST /v1/me/listening-history` takes only
  `stationId` in its body, the same "don't trust a client device's clock
  for an authoritative record" posture already applied to `moderated_at`/
  `deactivated_at` elsewhere.
- **No retention cap or automatic pruning in this step** — a deliberate,
  considered scope boundary, not an oversight: `DELETE
  /v1/me/listening-history` already gives every user a genuine
  right-to-erasure over their own history (the same posture `DELETE
  /v1/me` already holds for the account itself), and an unbounded personal
  log is a fundamentally different scale problem than the shared,
  ever-growing catalog tables this build has had to guard against
  test-pollution in — revisited if a real operational need for pruning
  emerges, the same "additive later, never premature" standard applied
  throughout this build.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 329-test suite (8 new in
`tests/listeningHistory.test.ts`) passing three consecutive runs; `npm
audit` clean; proven to actually catch a real bug by temporarily flipping
the listing query's `ORDER BY listened_at DESC` to `ASC` and watching the
exact test that checks most-recent-first ordering fail with the precise
reversed list before restoring it and confirming a byte-identical diff
against the pre-bug backup; and a live-server run against a running
compiled server — `401` with no token, `400` recording a listen for an
unknown station, a real listen recorded and hydrated with its station,
repeated listens against the same station all recorded as separate
entries, a deactivated station still correctly appearing in history (in
contrast to Step 51's favorites list), a hard-deleted station's history
entries preserved with `station: null`, and clearing one account's history
leaving another account's completely untouched — with all live test data
deleted afterward.

### Push notifications (Step 53)

The third step of the User Features bucket: the device push-token
registry, and the `PushProvider` abstraction the eventual sending side
will call, following the exact provider-abstraction pattern the "common
language" contract (`docs/ARCHITECTURE_PLAN.md` Section 1) already
established for email — a real interface plus a dev-safe default that
needs no credentials, chosen by whether the relevant credential env var is
set, with a loud startup warning when running on the dev-safe default.
Per the architecture plan's own sourced research: the standard, secure
push-notification architecture is `client → backend → FCM HTTP v1 API →
device` (Android direct, iOS via APNs, both through the same FCM API),
with the real service-account credential living only on the server, never
the client, and a device-token registry on the backend that overwrites on
every client-reported refresh — FCM tokens rotate on reinstall/restore, so
a stale registration must never linger silently.

- **`push_tokens`** (migration `1700000021000_push_tokens`) is a plain
  table with a database-level `UNIQUE` constraint on `token`, not a
  junction table like Step 51's favorites — a physical device's FCM token
  identifies one specific app installation, which belongs to exactly one
  account's session at a time, never two simultaneously. `registerPushToken`
  (`pushTokensRepository.ts`) is therefore a real upsert
  (`ON CONFLICT (token) DO UPDATE`), not a plain insert: re-registering an
  already-known token — the client's own periodic refresh, or a different
  account now signed in on the same physical device — overwrites
  `user_id`/`platform` and bumps `updated_at`, rather than erroring on the
  uniqueness constraint. Verified directly: the same token registered
  under a second account correctly disappears from the first account's
  list and appears in the second's.
- **`PushProvider`** (`src/notifications/types.ts`) is the one interface
  every future call site depends on — never a specific vendor's SDK, the
  identical role `EmailProvider` already plays for email.
  `ConsoleNotificationProvider` is the dev-safe default (logs instead of
  sending, exactly like `ConsoleEmailProvider`); `FcmPushProvider` is the
  real implementation, selected by `createPushProvider()` whenever
  `FCM_SERVICE_ACCOUNT_JSON` is set (the full service-account JSON key
  downloaded from the Firebase console, pasted into one env var — the
  standard way to carry this credential shape on a platform with no
  convenient way to mount a file), with the identical loud
  "no real provider configured" startup warning `createEmailProvider`
  already gives.
- **`FcmPushProvider` implements Google's own documented OAuth2 flow for a
  service account** (verified live against Firebase's current
  documentation during this step's research, not assumed from memory):
  sign a short-lived JWT (RS256, using the service account's own RSA
  private key — Node's built-in `crypto`, no Firebase Admin SDK dependency
  needed) with the standard claims (`iss`/`sub` = the service account
  email, `scope` = `https://www.googleapis.com/auth/firebase.messaging`,
  `aud` = `https://oauth2.googleapis.com/token`), exchange it for an
  access token via Google's "JWT Bearer Token" grant, then call
  `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` with
  that access token as a Bearer credential. The access token is cached in
  memory and refreshed 60 seconds before its real 1-hour expiry, rather
  than re-exchanged on every single notification.
- **A stale/invalid token is a distinct, catchable error from a transient
  provider failure.** FCM reports an unregistered or malformed token as a
  `404`/`400`; `FcmPushProvider` maps either to `InvalidPushTokenError` (a
  future notification-sending step's signal to delete that
  `push_tokens` row rather than retry it) instead of a generic send
  failure (`FcmSendError`), which is reserved for an actual provider-side
  problem.
- **No real FCM credential exists in this environment to send an actual
  live push notification against** (no Firebase project, no service
  account) — the identical honest limitation already true of the SMTP
  email provider in this sandbox. `FcmPushProvider`'s correctness (the
  JWT's exact shape and a real, independently-verified RS256 signature;
  the OAuth exchange and FCM send request shapes; the access-token cache;
  every error-mapping branch) is proven via unit tests against an injected
  `fetch` mock (`FetchLike`, dependency-injected the same way
  `createEmailProvider`/background workers already take their
  configuration as a parameter) rather than a real network call — the
  live-server verification below covers the token-registry API itself and
  the dev-safe `ConsoleNotificationProvider` path.
- **Not yet wired to any actual send trigger.** This step deliberately
  scopes to the registry and the provider abstraction only, per
  `docs/ARCHITECTURE_PLAN.md`'s own description of this piece of the User
  Features bucket — deciding *when* to notify a user (a future event in a
  favorited category, a followed station coming back online, etc.) is a
  real feature decision for a later step in this bucket, not invented
  speculatively here just because the sending mechanism now exists.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 350-test suite (21 new, split between
`tests/pushTokens.test.ts`'s real-API integration tests and
`tests/pushNotifications.test.ts`'s provider unit tests — including a
real RSA key pair generated at test time to independently verify the
JWT's signature actually validates, not just that it's well-shaped JSON)
passing three consecutive runs; `npm audit` clean; proven to actually
catch a real bug by temporarily narrowing `FcmPushProvider`'s
stale-token detection from `404 || 400` to `404` only and watching the
exact test that checks the `400`/malformed-token case fail (surfacing as
the wrong error class, `FcmSendError` instead of `InvalidPushTokenError`)
before restoring it and confirming a byte-identical diff against the
pre-bug backup; and a live-server run against a running compiled server
covering the token registry end-to-end — `401` with no token, `400` for
an invalid `platform`, a real token registered and listed, idempotent
re-registration correctly refreshing `updatedAt`, the same token
re-registered under a second account correctly transferring ownership
(disappearing from the first account's list, appearing in the second's),
and idempotent un-registration — with all live test data deleted
afterward.

### Notification preferences and the favorite-station-availability trigger (Step 54)

The fourth step of the User Features bucket: notification preferences,
and — per `docs/ARCHITECTURE_PLAN.md`'s own description of this piece of
the bucket — the first real trigger for Step 53's `PushProvider`, wiring
together three features already built (favorites, push tokens, the
provider abstraction) into one concrete, working notification: a user is
notified the moment a station they favorited becomes unavailable or comes
back.

- **`notification_preferences`** (migration
  `1700000022000_notification_preferences`) is a one-row-per-user table
  (`user_id` itself is the primary key, not a separate serial id — there's
  exactly one preferences row per account by definition, the same
  "profile extension, not a many-to-many relationship" shape as `users`
  itself). No row is created at registration; `GET
  /v1/me/notification-preferences` returns the default
  (`favoriteStationAvailabilityChanges: true`) for any account that's
  never customized it, and `PATCH` creates the row lazily (upsert) on
  first customization — "never set" and "explicitly set to the default"
  are deliberately indistinguishable from the outside, the simplest
  correct contract for a feature with exactly one preference so far.
- **The trigger point is a real, existing state transition, not a new
  hook invented for this feature.** `updateStation`
  (`stationsRepository.ts`) is the single choke point every `isActive`
  change already passes through — both a human admin's
  `PATCH /v1/stations/:id` and the automatic stream-reliability monitor
  (`stationHealth/autoDeactivationWorker.ts`, Step 23) call it — so
  `notifyFavoriteStationAvailabilityChange`
  (`src/notifications/favoriteStationAvailabilityNotifier.ts`) is called
  from both of those call sites right after a successful update,
  keeping the repository layer itself a pure data-access function with no
  new side effects mixed in.
- **Only a genuine flip triggers a notification, never a redundant
  write.** `routes/stations.ts` fetches the station before the update
  specifically to compare its previous `isActive` against the new value —
  a repeated `PATCH { isActive: false }` on an already-inactive station
  correctly notifies nobody a second time. The automatic monitor needs no
  such check: every station it ever touches came from
  `listActiveStationsForHealthCheck` (active-only), so a successful call
  there is always a genuine true→false transition by construction.
- **Every recipient is filtered through two independent gates before a
  single push is attempted**: `listNotificationPreferencesForUsers`
  (a user who opted out of `favoriteStationAvailabilityChanges` is
  skipped entirely) and `listPushTokensForUsers` (a user with no
  registered device has nothing to send to). Every remaining token is
  sent to independently and in parallel, with per-token error isolation —
  the identical reasoning already applied to Step 20's `sweepStations`:
  one dead device must never stop the notification from reaching everyone
  else who favorited the same station.
- **A provider-reported stale token cleans itself up.** When
  `FcmPushProvider` (or any future `PushProvider`) raises
  `InvalidPushTokenError` for a specific send, the notifier deletes that
  exact `push_tokens` row (by its own id) rather than leaving a dead
  registration to fail the same way on every future notification.
- **The entire fan-out is a best-effort side effect, never a reason to
  fail the station update itself.** Every layer — a single token's send,
  the whole fan-out — is wrapped so a failure here is logged and
  swallowed, never propagated back to the `PATCH /v1/stations/:id`
  caller. This is the same "a component that can degrade gracefully
  should, rather than propagating a hard crash" standard already applied
  throughout this build's background workers, verified directly: the live
  server run below confirms the update's own `200` response is unaffected
  either way.
- **A verified, incidental confirmation, not a new mechanism**: the
  registered device token in the live-server run's own log output for a
  sent notification came back `"token":"[redacted]"` — the existing
  wildcard field-name redaction (Step 04, "Observability" below) already
  covers any field literally named `token` anywhere in a log line,
  including this new one, with no additional configuration needed.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 361-test suite (11 new, split between
`tests/notificationPreferences.test.ts`'s API tests and
`tests/favoriteStationAvailabilityNotifier.test.ts`'s notifier tests
against a fake, dependency-injected `PushProvider`) passing three
consecutive runs; `npm audit` clean; proven to actually catch a real bug
by temporarily removing the opt-out preference filter from the notifier
and watching the exact test that checks an opted-out user is skipped fail
(they were wrongly notified anyway) before restoring it and confirming a
byte-identical diff against the pre-bug backup; and a live-server run
against a running compiled server — favoriting a real station, registering
a real push token, confirming the default preference is `true`,
deactivating the station as an admin and confirming both the `200`
response and a correctly-titled/bodied "unavailable" notification in the
server's own log output, a redundant repeat `PATCH` correctly producing no
second notification, and reactivating correctly producing a "back"
notification — all live test data deleted afterward.

### User Features bucket closing adversarial pass (Step 55)

The fifth and final step of the User Features bucket (Steps 51-54), the
same "the closing step reviews and hardens everything the bucket built"
shape as Steps 18/23/30/38's own bucket closers — a systematic adversarial
sweep across favorites, listening history, push tokens, and notification
preferences, plus (since the sweep isn't scoped to a single route file) a
codebase-wide fix the sweep surfaced.

**Real finding: every id-shaped integer field in this entire API had no
upper bound.** Every route accepting a station/event/country/genre/
language/category id — as a path param, a body field, a querystring
filter, or an array-of-ids item — validated only `{ type: "integer",
minimum: 1 }`, with nothing stopping an absurdly large value. A value like
`99999999999999999999` still passes AJV's own `type: "integer"` check
(very large whole numbers remain integers in the IEEE-754 double precision
both AJV's type coercion and JavaScript's own `Number` use), so it reached
the repository layer and hit Postgres's `integer` (int4) column type
directly — every `serial` primary key and its foreign-key references in
this project's own migrations are int4 by default, confirmed directly
against every `CREATE TABLE`, whose documented range
(postgresql.org/docs/current/datatype-numeric.html) is exactly
-2147483648 to 2147483647. The result was a raw, unhandled `"value ...
out of range for type integer"` database error surfacing as a `500`, not
the clean `400` a malformed id should produce — reproduced live against a
running compiled server (`PUT /v1/me/favorites/stations/
99999999999999999999`) before writing the fix, not assumed. Fixed with one
shared, bounded schema, `idSchema` (`schemas/common.ts`,
`{ type: "integer", minimum: 1, maximum: 2147483647 }`), replacing the
bespoke unbounded inline schema at all 35 call sites across `routes/
favorites.ts`, `listeningHistory.ts`, `me.ts`, `stations.ts`, `users.ts`,
`stationHealth.ts`, `stationRanking.ts`, `events.ts`, and `schemas/
stations.ts`/`events.ts` — one definition now protects every id field in
this API, and a future id field reuses it instead of risking the same gap
by copying an old inline schema. Regression-proofed by temporarily
removing the `maximum` bound and watching the exact new tests fail with
`500` instead of `400` before restoring it and confirming a byte-identical
diff against the pre-bug backup.

**A hypothesis investigated and correctly reversed, not shipped —
recorded here as real due diligence, not hidden.** While probing this same
class of gap, `PATCH /v1/me/notification-preferences` with a body of only
`{ role: "admin" }` (no recognized field at all) was found to return `200`
with the preference silently unchanged, rather than the `400` a request
with zero valid fields should get from its own `minProperties: 1`
constraint. Root cause: Fastify's ajv compiler defaults to
`removeAdditional: true` (`@fastify/ajv-compiler`'s own
`default-ajv-options.js`, confirmed directly against the installed
package), and per ajv's own documented semantics that makes an explicit
`additionalProperties: false` silently delete an unrecognized field and
let validation pass, rather than fail it — `minProperties` is evaluated
against the field count *before* that removal happens. The obvious-looking
fix, disabling `removeAdditional` globally in `app.ts`'s Fastify
constructor, was implemented, built, and run against the full suite before
being reverted: it broke three pre-existing, deliberately-written tests —
`tests/adminRole.test.ts`'s "strips a client-supplied role field on
registration - role can never be self-assigned", and two equivalent tests
in `stations.test.ts`/`events.test.ts` — that already rely on this exact
silent-strip behavior as this codebase's own established mass-assignment
defense: a forbidden field (`role`, event `status`) is dropped and the
rest of the request proceeds normally, rather than failing the whole
request outright. Changing the global default would have reversed a
correct, previously-verified security decision to "fix" what turned out
not to be a bug. `tests/notificationPreferences.test.ts`'s own adversarial
test was rewritten to confirm the real, correct behavior instead — this
endpoint already benefits from the same protection, previously unverified
for this specific route, and is not a gap.

Also added, mirroring Step 38's own "prove the whole bucket's surface
survives adversarial input" shape: malformed/negative/non-integer/
SQL-injection-shaped path params across favorites (with the underlying
`users` table's presence confirmed unchanged before and after, not merely
trusted); a push-token length boundary test (exactly `MAX_PUSH_TOKEN_LENGTH`
accepted, one character over rejected); a SQL-injection-shaped push-token
value proven to round-trip as inert stored data with the `push_tokens`
table itself still present and queryable afterward, not merely assumed
inert from parameterization alone. A full end-to-end review of
`favorites.ts`/`listeningHistory.ts`/`pushTokens.ts`/
`notificationPreferences.ts`/`favoriteStationAvailabilityNotifier.ts` for
field-name drift or an inconsistent null-contract across the four steps
that built them — the same review Step 38 did for `commandResolver.ts` —
found none: camelCase field names, ownership scoping via `request.user.sub`,
and idempotency semantics are all consistent across every route in the
bucket.

Verified: clean build and lint; the full 405-test suite (14 new, split
across `tests/favorites.test.ts`, `tests/stations.test.ts`,
`tests/events.test.ts`, `tests/adminUsers.test.ts`,
`tests/listeningHistory.test.ts`, `tests/pushTokens.test.ts`, and
`tests/notificationPreferences.test.ts`) passing three consecutive runs;
`npm audit` clean; `gitleaks` clean against the real repository; and a
live-server run against a running compiled server confirming an
out-of-range id correctly `400`s (path param, body field, and querystring
filter, across favorites/stations/events) instead of the pre-fix `500`,
and confirming the reversed hypothesis's correct final behavior — a
role-only `PATCH /v1/me/notification-preferences` still returns `200`
unchanged, and a `role: "admin"` on registration is still silently
stripped rather than rejected or honored — all live test data deleted
afterward. **This closes the User Features bucket (Steps 51-55)**: a
complete, backend-verified favorites/listening-history/push-notifications/
preferences feature set with a real, defensible v1 hardening pass behind
it, a genuine cross-cutting bug found and fixed along the way, and one
plausible-looking fix correctly investigated and rejected rather than
shipped on assumption.

## Advertising

### Ad placement configuration (Step 56)

Per `docs/ARCHITECTURE_PLAN.md`'s own sourced research, real mobile ad
monetization runs through a client-side mediation SDK (e.g. AdMob) that
itself connects to multiple ad networks/SSPs and handles actually serving
creative, tracking impressions/clicks, and payment — building a custom
ad-serving/tracking backend from scratch would be reinventing what a real
ad network already does, not a defensible engineering choice. This
backend's scope is deliberately narrower and honest about it: ad
**configuration** — which ad unit/placement ids are active, per country
and screen — fully buildable and testable with zero ad network account.

Added `ad_placements` (migration `1700000023000_ad_placements`):
`placementKey` (a stable identifier the client's own code references
directly, e.g. `station_list_banner`), a nullable `countryId` (`null` =
the global default for that placement, a real value = a country-specific
override), `adFormat` (a DB CHECK-constrained enum matching AdMob's own
documented formats — `banner`/`interstitial`/`rewarded`/`native`), and
separate `androidAdUnitId`/`iosAdUnitId` columns (AdMob issues a distinct
ad unit id per platform even for what a human calls "the same placement",
since Android and iOS apps are registered as separate AdMob "apps" in its
own console).

Two real database-level integrity guarantees, not just application code:

- **NULL-uniqueness fix**: a plain `UNIQUE(placement_key, country_id)`
  constraint would silently allow multiple "global default" rows for the
  same `placementKey`, since Postgres treats every `NULL` as distinct
  from every other `NULL` — a genuine, well-known Postgres gotcha, not a
  hypothetical one. Closed with a partial unique index
  (`ad_placements_global_key_unique ON ad_placements (placement_key)
  WHERE country_id IS NULL`) alongside the plain constraint for the
  non-null, per-country case.
- **`ad_placements_active_requires_ad_unit_id`**: a CHECK constraint
  (`(NOT is_active) OR android_ad_unit_id IS NOT NULL OR
  ios_ad_unit_id IS NOT NULL`) backstopping the application-level
  validation in `routes/ads.ts` — a placement can be staged with neither
  ad unit id set while ids are still being requested from the ad
  network, but can never actually be activated empty.

Full admin API (`[app.authenticate, app.requireAdmin]`): `POST`/`GET`/
`GET :id`/`PATCH`/`DELETE /v1/admin/ads/placements`, plus the real
client-facing resolution endpoint, `GET /v1/ads/config?countryId=` —
public, unauthenticated, returning one entry per active `placementKey`
visible to that country, preferring a country-specific override over the
global default when both exist. That preference is implemented with
`DISTINCT ON (placement_key) ... ORDER BY placement_key, country_id ASC
NULLS LAST` — for each `placementKey` group, Postgres keeps only the
first row in `ORDER BY` order, and a non-null `country_id` always sorts
before a `NULL` one under `NULLS LAST`, so the country-specific row wins
whenever both exist and are active.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 423-test suite (18 new in `tests/ads.test.ts`)
passing three consecutive runs; `npm audit` clean; `gitleaks` clean;
proven to actually catch two real bugs by temporarily (a) flipping the
`DISTINCT ON` resolution query's `NULLS LAST` to `NULLS FIRST` and
watching the exact override-preference test fail with the global
placement returned instead of the country-specific one, and (b) dropping
the partial unique index and watching the exact duplicate-global-placement
test wrongly succeed with `201` instead of `409`, in both cases restoring
immediately and confirming a byte-identical diff against the pre-bug
backup; and a live-server run against a running compiled server — a
staged global placement created inactive, a country-specific active
override created for a real country, and `GET /v1/ads/config` for that
country correctly resolving to the override, not the global default — all
live test data deleted afterward.

### Frequency capping and placement-level reporting (Step 57)

The second and final Advertising step. Per `docs/ARCHITECTURE_PLAN.md`'s
own scoped research, this backend owns the frequency-cap **rule**, never
its enforcement — real mediation SDKs frequency-cap on-device, since a
specific device's own impression count is the only place it can actually
be tracked (most of this app's ad-eligible screens require no login at
all, so most listeners have no persistent identity this backend could
count against anyway). Added `maxImpressionsPerPeriod`/
`frequencyCapPeriod` (migration `1700000024000_ad_placements_frequency_cap`,
a plain `addColumn` on Step 56's existing table, not a rewrite of it) —
both null (no cap) or both set (a real `session`/`day`-scoped cap),
enforced together by a CHECK constraint backstopping the identical
application-level validation `routes/ads.ts` already applies for
`androidAdUnitId`/`iosAdUnitId`. Both values are returned from
`GET /v1/ads/config` unchanged, for the client's own on-device counting.

Also added first-party **placement-level reporting** — a mediation SDK's
own dashboard doesn't give a Caribbean-specific view of how a placement
performs. `ad_events` (migration `1700000025000_ad_events`) is a plain
event log with no `user_id` (most impressions come from anonymous
listeners, and per-user ad analytics was never this step's scope),
`country_id` `SET NULL` on that country's own deletion (a real recorded
impression shouldn't be erased just because the country row later is —
the same reasoning already applied to `radio_stations.created_by_user_id`),
and `placement_id` **CASCADE** — the deliberate difference from
`country_id`, since this table's entire reporting shape is organized *by*
placement, the identical "a diagnostic/reporting child table cascades
with its parent" precedent `station_health_checks` (Step 19) already
established. `POST /v1/ads/events` is public and unauthenticated (the
same population it's reporting on), rate-limited to 60/min — looser than
a moderation-queue endpoint (`POST /v1/events`, Step 58's own API6 fix)
since real ad traffic can legitimately fire several of these per session,
but still a real, dedicated bound rather than relying on the global limit
alone. `GET /v1/admin/ads/reports` (admin-only) aggregates impressions/
clicks per placement via a `LEFT JOIN ad_events ... GROUP BY placement`,
with the country/date-range filters placed inside the join's own `ON`
clause rather than a `WHERE` on the joined result — a `WHERE` there would
silently turn the `LEFT JOIN` into an inner join for any placement whose
only events fall outside the filtered window, dropping it from the report
entirely instead of correctly showing a real `0` for that window. Every
currently-existing placement always appears in the report, zero counts
included — an admin comparing performance needs "this one got zero
impressions" as a visible data point, not a silently missing row.

Verified: migration up/down/up on both dev and test databases; clean
build and lint; the full 436-test suite (13 new) passing three
consecutive runs; `npm audit` clean; `gitleaks` clean; proven to actually
catch two real bugs by temporarily (a) moving the report query's country/
date filters from the join's `ON` clause to a `WHERE` clause and watching
the exact zero-count test wrongly drop the filtered-out placement instead
of showing it with `0`, and (b) dropping the
`ad_placements_frequency_cap_together` CHECK constraint and confirming a
direct SQL insert with a mismatched pair (`maxImpressionsPerPeriod: 5,
frequencyCapPeriod: null`) was wrongly accepted at the database level, in
both cases restoring immediately and confirming a byte-identical diff (or
constraint re-creation) against the pre-bug state; and a live-server run
against a running compiled server — a real placement created with a
5-per-day cap, `GET /v1/ads/config` correctly returning that cap
unchanged, two impressions and one click recorded, and
`GET /v1/admin/ads/reports` correctly reflecting exactly those counts —
all live test data deleted afterward. **This closes the Advertising
bucket (Steps 56-57)**: ad configuration, frequency-cap rules, and
first-party placement-level reporting, all genuinely backend-buildable
and verified without any real ad network account, per the architecture
plan's own honest scoping of this backend's role.

### OWASP API Security Top 10 audit (Step 58 continued)

Following the CI/monitoring work above, this backend was audited against
the current, authoritative OWASP API Security Top 10 (the 2023 edition —
confirmed live during this step's research to still be the current
standard as of 2026, with no newer edition published) — a concrete,
sourced checklist rather than an open-ended "harden things" pass. Two
genuine, previously-unaddressed gaps were found and fixed; one suspected
gap was investigated and found to already be correctly handled, which is
recorded here as a real, verified outcome rather than a silent non-finding
(the same "no bug found is still a real result" precedent Step 38's own
adversarial pass established).

**API7:2023 — Server-Side Request Forgery.** `checkStreamHealth`
(`src/utils/streamHealthCheck.ts`, Step 19) makes a real outbound request
to a station's `streamUrl` — admin-supplied at station creation/update and
re-fetched automatically every few minutes by the background health-check
worker (Step 20). OWASP's own guidance treats exactly this shape (a
server-side request to a URL the caller controls) as SSRF risk even for a
trusted/authenticated role, not only anonymous public input — an admin
account being phished, a compromised admin credential, or a simple typo
could otherwise point this backend's own outbound request at an internal
service or a cloud metadata endpoint (`169.254.169.254`) with no
protection at all, which is exactly the state this code was in before this
step.

- **`src/utils/ssrfProtection.ts`** (`assertPublicHostname`) resolves a
  hostname's real address(es) and rejects any that fall inside a private/
  reserved network range, using Node's own built-in `net.BlockList` (core
  since Node 15, confirmed live against nodejs.org's own documentation —
  well before this project's `>=20` engines requirement) rather than a
  third-party SSRF-guard package: several exist, but none carry the kind
  of maturity/adoption signal this build has required before depending on
  anything else (`nodemailer`, `@prometheus-io/client`) — a zero-dependency
  built-in is the stronger, more defensible choice. Covers both IPv4
  (loopback, current-network, link-local/metadata, all three RFC 1918
  ranges, CGNAT, benchmarking) and IPv6 (loopback, unique-local,
  link-local) — `BlockList.check()` transparently handles IPv4-mapped IPv6
  addresses like `::ffff:127.0.0.1` once IPv4 rules are registered, per
  Node's own documented example, confirmed directly.
- **Every redirect hop is re-validated, not just the starting host.**
  `checkStreamHealth` switched from `redirect: "follow"` to a small,
  bounded (5-hop) manual loop that re-runs the same hostname check before
  following each `Location` header — closing the specific bypass a single
  up-front check alone would miss (a `streamUrl` that itself resolves to a
  public address but redirects to an internal one). Confirmed directly,
  not assumed from browser-`fetch` behavior, that Node's own `fetch`/undici
  exposes the real status and `Location` header in `redirect: "manual"`
  mode (unlike a browser's `fetch`, which returns an opaque, unreadable
  response for a manual-mode cross-origin redirect — a same-origin-policy
  protection with no meaning in a server context) — tested against a real
  local redirecting server before relying on it.
- **An honest, documented residual limitation, not a false sense of
  complete safety**: this validates a hostname immediately before use, but
  the underlying `fetch()` call re-resolves DNS independently when it
  actually connects. A sophisticated attacker controlling DNS for the
  target hostname with a near-zero TTL could in principle swap the record
  between this check and the connection ("DNS rebinding"). Fully closing
  that requires pinning the validated IP at the socket/dispatcher layer (a
  custom `undici` `Agent`), which is disproportionate complexity for what
  remains an admin-authenticated-only input surface (this project's real
  threat model here), not anonymous public input — a deliberate,
  documented scope boundary, the same kind already applied to listening
  history's no-retention-cap decision (Step 52).
- **Existing Step 19-23 integration tests deliberately point real local
  test servers at loopback addresses** to exercise real sockets — now
  correctly refused by the real default. Rather than weaken the guard or
  thread a bypass parameter through the worker/route call chain, the two
  affected test files (`tests/healthCheckWorker.test.ts`,
  `tests/stationHealth.test.ts`) mock `ssrfProtection.ts` at the module
  level: both files' own job is proving the sweep loop's and the admin
  route's own behavior (concurrency, error isolation, request/response
  wiring), which is orthogonal to hostname safety — that real behavior is
  proven exhaustively, without mocking anything, by
  `tests/ssrfProtection.test.ts` and `tests/streamHealthCheck.test.ts`'s
  own dedicated SSRF suite. No production code path is affected either
  way — the real default is never overridden outside test files.

**API4:2023 — Unrestricted Resource Consumption.** `push_tokens` (Step 53)
had no cap of any kind on how many distinct tokens one account could
register — only the API's own global rate limit (100/min) throttled how
*fast* a compromised or malicious account could grow it, not how *far*.
Added `MAX_PUSH_TOKENS_PER_USER` (20 — generous relative to how many real
devices/reinstalls one person realistically has, while still a genuine,
enforced bound) to `registerPushToken`, using the identical `SELECT ...
FOR UPDATE`-based concurrency-safe pattern `usersRepository.setUserRole`
already uses for its own "count this account's rows, then decide"
invariant (the last-remaining-admin protection) — two concurrent
registrations can never both read "under the cap" and both proceed past
it. Re-registering a token the account already owns (the client's own
periodic refresh) never counts against the cap, only a genuinely
new-to-this-account token does (brand new, or transferred from a different
account) — verified directly that a refresh still succeeds exactly at the
cap, and that un-registering a token frees a real slot for a new one.
`409` (a state-based conflict, the same status this API already uses for
"can't demote the last admin") rather than `400`, since the request itself
is perfectly well-formed.

**API6:2023 — Unrestricted Access to Sensitive Business Flows.** `POST
/v1/events` (Step 55) had only this API's own global rate limit (100/min)
protecting it — no limit specific to that route. A regular user's own
event-submission queue directly feeds the public events list (after
moderation) and, before moderation, occupies a real, finite admin-review
resource; OWASP's own API6 guidance treats a business flow that consumes a
disproportionate downstream resource per request (here: a human
moderator's attention, not just database load) as needing its own
tighter limit, distinct from generic anti-abuse rate limiting. Added a
dedicated `rateLimit: { max: 10, timeWindow: "1 minute" }` directly on the
route's own `config`, the same per-route override mechanism already used
for `POST /v1/users` (5/min, since it hashes a password and writes to the
DB on every call) — verified directly that an 11th submission within a
minute from the same account is rejected with `429` while the first 10
succeed with `201`, and that this is scoped per-account (the existing
JWT-based rate-limit key), not global.

**API10:2023 — Unsafe Consumption of Third-Party APIs.**
`FcmPushProvider` (`src/notifications/providers/fcmPushProvider.ts`, Step
53) makes two outbound calls to Google's own infrastructure — an OAuth2
token exchange against `oauth2.googleapis.com` and the actual push send
against `fcm.googleapis.com` — and neither carried any timeout at all.
OWASP's own API10 guidance calls out exactly this shape (trusting a
third-party API to always respond promptly, with no bound of your own) as
a risk: a hung or merely slow-to-respond Google endpoint would stall that
one call indefinitely, which in turn stalls
`favoriteStationAvailabilityNotifier`'s `Promise.all` fan-out for that one
device token, which in turn stalls the admin's own synchronously-`await`ed
`PATCH /v1/stations/:id` request (Step 54's wiring) for as long as
Google's connection stayed open — an availability risk this backend has no
control over once it hands control to an unbounded third-party call.
Added a `FCM_FETCH_TIMEOUT_MS` (10s) bound to both calls via
`AbortSignal.timeout()` — a Node core API confirmed via research (not
assumed from memory) to have been added in Node v16.14.0/v17.3.0, well
within this project's own `engines >=20` floor, and the identical
timeout-bounding discipline `checkStreamHealth` (API7 above) already
applies to its own outbound call. 10s is more generous than
`checkStreamHealth`'s 8s default since these are small JSON request/
response round trips to a well-provisioned Google endpoint, not a
real-world radio stream server of unknown quality. The timeout itself is
injectable via a third, defaulted constructor parameter — production
always uses the real 10s default, but `tests/pushNotifications.test.ts`'s
new timeout-protection suite passes a 20ms value against a deliberately
hung mock `fetchImpl` (one that never resolves on its own but does honor
the `AbortSignal` it's given, the same real contract Node's own
fetch/undici implementation has) so the test proving the abort actually
fires runs in milliseconds, not the real 10 seconds.

**API8:2023 — Security Misconfiguration (CORS, investigated).** Checked
whether the complete absence of any CORS configuration on this API was a
gap, given the Admin Dashboard (Steps 31-33) is a real browser client on
what could be a different origin. Found it is not: `admin-dashboard/vite.config.ts`
already documents a deliberate same-origin reverse-proxy architecture
(the dashboard's own API calls are proxied to same-origin `/v1/...` in
both `vite dev` and the documented production reverse-proxy setup)
specifically so this backend never needs to answer a genuine cross-origin
browser request at all — the current "no CORS headers set" behavior is
the correct, secure default for an API with no legitimate cross-origin
browser caller, not an oversight. Adding an origin-allowlist CORS layer on
top would have undone a correct, already-documented design decision rather
than fixed a real gap, so none was added — recorded here as a genuine,
verified audit outcome, the same "no bug found is still a real result"
standard already applied elsewhere in this build.

Verified: clean build and lint; the full 394-test suite (23 new, split
between `tests/ssrfProtection.test.ts`'s direct unit tests,
`tests/streamHealthCheck.test.ts`'s new SSRF-integration describe block,
`tests/pushTokens.test.ts`'s new cap describe block, `tests/events.test.ts`'s
new rate-limit describe block, and `tests/pushNotifications.test.ts`'s new
timeout-protection describe block) passing three consecutive runs; `npm
audit` clean; `gitleaks` clean against the real repository; proven to
actually catch real bugs by temporarily (a) removing the `169.254.0.0/16`
metadata-endpoint subnet rule from `ssrfProtection.ts` and watching both
the direct unit test and the `checkStreamHealth`-level integration test
fail with the exact wrong (allowed-through) result, (b) disabling the cap
check in `registerPushToken` and watching the exact cap test fail with
`204` instead of `409`, and (c) removing the `AbortSignal.timeout()`
wiring from both of `FcmPushProvider`'s outbound calls and watching both
hung-call timeout tests genuinely hang and fail on vitest's own 5s test
timeout (rather than the intended 20ms), in every case restoring
immediately and confirming a byte-identical diff against the pre-bug
backup; and a live-server run against a running compiled server — a real
admin-created station pointed at the cloud metadata endpoint and,
separately, at a loopback address both correctly recorded as unreachable
via the manual health-check endpoint with the SSRF error message and zero
connection latency (proving no connection was ever attempted), and a real
account registering exactly 20 push tokens successfully, a 21st correctly
rejected with `409`, and a re-registration of the very first token still
succeeding at the cap — all live test data deleted afterward.

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
`backend/**`: install, scan for secrets, build, lint, statically analyze
for security issues, migrate a real Postgres service container, run the
full test suite, and `npm audit --audit-level=high` (fails the build on a
high/critical vulnerability) — the same sequence manually verified by hand
at every step so far, now enforced automatically on every future change
rather than relying on remembering to run it.

## CI security gates and production monitoring (Step 58)

The first step of the Reliability / Security / Monitoring bucket (Steps
58–60) — real, verified additions to the CI pipeline and a first
production-observability surface, not the whole bucket at once.

### Secrets scanning (gitleaks)

`.github/workflows/backend-ci.yml`'s "Scan for secrets" step installs the
[gitleaks](https://github.com/gitleaks/gitleaks) CLI directly from its
GitHub release (checked live during this step's research: the CLI itself
is MIT-licensed and free for CI use — deliberately *not* the
`gitleaks-action` Marketplace wrapper, whose v2+ requires a paid EULA for
organization use; the underlying tool it wraps has no such restriction)
and scans the **checked-out working tree** (`--no-git`), not full git
history. That's a deliberate scope, not an oversight: a one-time full-history
scan was run manually during this step's own verification (56 commits,
confirmed clean of any real secret — the single flagged historical string
was the same test-fixture false positive `.gitleaksignore` allowlists
below) — a real secret in an already-merged historical commit can't be
un-committed by a check on today's PR anyway, so the ongoing CI gate scans
exactly what matters for blocking a merge: the tree as it would ship.

`backend/.gitleaksignore` allowlists exactly one confirmed false positive
by its precise fingerprint (path:rule:line, not a whole-file or
whole-rule exemption): `tests/pushNotifications.test.ts`'s deliberately
fake, PEM-*shaped* private key fixture (used only to test
`parseFcmConfig`'s field-presence validation — it never needs to be a
real, parseable key). A real secret introduced anywhere else in that same
file, or on a different line, is still caught.

### Static analysis (Semgrep)

The "Static analysis" step installs a pinned Semgrep CLI version via pip
and runs Semgrep's own `p/ci` registry ruleset — Semgrep's documented,
curated default for CI use specifically because of its low false-positive
rate, as opposed to enabling every registry rule at once. The Semgrep CLI
engine itself is LGPL-2.1 and free/unlimited for CI use with no login
required (checked live, not assumed: only the separate, opt-in Semgrep
AppSec Platform is a paid product, never invoked here). Verified locally
during this step with a custom sanity rule confirming Semgrep correctly
parses 100% of this codebase's TypeScript and finds zero raw
SQL-string-concatenation patterns — an independent, tool-based
confirmation of this API's own "every query is parameterized" standing
claim, not just a restatement of it.

### Production metrics (`GET /metrics`)

A Prometheus-compatible scrape endpoint, unversioned like `/health` —
infrastructure surface for a monitoring scraper, not API contract a
client depends on. Backed by
[`@prometheus-io/client`](https://github.com/prometheus/client_js)
(Apache-2.0) — the official Prometheus project's own Node.js client,
which has replaced the long-standing community `prom-client` package
(confirmed via npm during this step's own research: `prom-client` is now
marked deprecated upstream in favor of this one, despite its much longer
install history — recall would have picked the wrong package here,
exactly the scenario this build's "verify, don't assume" licensing/technical
standard exists for).

- **Default Node.js process metrics** (CPU, memory, event-loop lag, GC,
  active handles) via a single `collectDefaultMetrics()` call — the same
  "don't hand-roll what a real library already does correctly" reasoning
  already applied to choosing `nodemailer` over a hand-rolled SMTP client.
- **`http_request_duration_seconds`**, a histogram recorded once per
  request via a single `onResponse` hook in `app.ts` — covering every
  route this API serves without instrumenting each one individually.
  Labeled by `method`/`route`/`status_code`, where `route` is the
  **templated** pattern Fastify itself resolved the request to (e.g.
  `/v1/stations/:id`), never the literal request URL — verified directly:
  a request against a real numeric station id produces a metric labeled
  `route="/v1/stations/:id"`, with the actual id nowhere in the output, so
  the metric can never fan out into one time series per distinct id/value
  a caller happens to send.
- **Gated by `METRICS_TOKEN` in production, open in development/test.**
  The identical "restricted only in production" shape already established
  for `ENABLE_API_DOCS` — an unauthenticated process-internals endpoint
  reachable on a public network is a real information-disclosure risk
  (route names, request volumes, error rates), so `METRICS_TOKEN` is
  required at startup in production (the server refuses to start without
  it, the same fail-fast posture as `JWT_SECRET`) and checked via
  `Authorization: Bearer <token>` with a constant-time comparison; a local
  Prometheus/curl check needs no setup at all outside production.
- **Alert thresholds** (for whatever scrapes this endpoint — Prometheus
  Alertmanager or equivalent) should start from: `http_request_duration_seconds`
  P99 exceeding 1s sustained for 5 minutes on any route other than
  `POST /v1/voice/command` (this API's own documented heaviest single
  endpoint); `process_resident_memory_bytes` approaching the deployment's
  configured memory limit; and the existing `station_health_checks`/
  `email_outbox` tables' own failure counts (not yet exposed as metrics
  here — a natural follow-up for a later step in this bucket, not invented
  speculatively now).

Verified: clean build and lint; the full 371-test suite (10 new in
`tests/metrics.test.ts`) passing; `npm audit` clean; `gitleaks`/`semgrep`
run locally against the real repository as described above, both clean
after the one documented, justified allowlist entry; and a direct check
that `GET /metrics` returns real Prometheus exposition-format text
containing both a default process metric and a real recorded HTTP request
duration for an actual request this test suite made, labeled correctly by
route pattern rather than literal URL.
