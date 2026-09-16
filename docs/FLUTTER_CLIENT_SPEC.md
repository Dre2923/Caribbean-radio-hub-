# Flutter Client & Platform Audio — Architecture/API-Contract Specification

**Covers:** Steps 39–45 (Flutter Client & Premium Design) and Steps 46–50
(Platform Audio), combined into one document per `docs/ARCHITECTURE_PLAN.md`
Section 4's own working-plan directive ("Steps 39–50 are built as one
thorough architecture/API-contract specification document").

## Status — read this before anything else

**This is a specification, not shipped/verified code.** Every other step in
`docs/BUILD_MANIFEST.md` up through Step 38 means "built, tested against a
real database/server, verified live, confirmed." This document means
something different and is not being represented as more than it is:

- This backend-only session has Node.js/TypeScript/Fastify/Postgres and a
  pre-installed Chromium + Playwright — confirmed by `docs/ARCHITECTURE_PLAN.md`
  Section 2 (`ls` at the repo root shows only `backend/`, `admin-dashboard/`,
  and `docs/`). It has **no Dart/Flutter SDK, no iOS/Android/Windows
  toolchain, and no simulator, emulator, or real device.**
- Nothing here has been compiled, run, or tested. No Dart code is written or
  claimed to work.
- What this document *is*: a complete, zero-ambiguity brief — screen
  inventory, navigation structure, state-management approach, package
  choices (each sourced against a current reference, not assumed), and,
  for every single screen and interaction, the **exact, already-verified**
  backend endpoint it calls (method, path, query/body shape, response
  shape, status codes — all copied from `backend/README.md` and the real
  schema files in `backend/src/schemas/*.ts`, never invented or
  misremembered) — so that a real Flutter environment (a follow-up session
  with the toolchain, or a human developer) can implement Steps 39–50 from
  this document alone, with no ambiguity about what the backend already
  provides, and no separate research pass needed.
- `docs/BUILD_MANIFEST.md`'s Progress Log records Steps 39–45 and 46–50 as
  **"Specified — not built/tested"**, a status distinct from every
  code-verified step, so this is never confused with a completed step.

Every backend endpoint, field name, status code, and schema cited below was
read directly from `backend/README.md` (as of the Step 38 / Voice System
bucket close) and `backend/src/schemas/{common,stations,events,voice}.ts`
during this document's own research pass — not recalled. Where a technology
or package choice below is a judgment call rather than a restatement of an
existing project decision, it's checked against a current external source
and cited, the same standard `docs/ARCHITECTURE_PLAN.md` already holds
itself to.

---

## 1. Scope and target platforms

Per `docs/BUILD_MANIFEST.md`'s Project Standard: **Android, iPhone/iPad, and
Windows** (macOS deferred). Flutter is the correct single-codebase choice
for this exact platform set — one of very few production-grade frameworks
with first-class, actively maintained support for all three plus desktop,
which is why `docs/ARCHITECTURE_PLAN.md` already assumed it as the target
framework for Steps 39–50.

Steps 39–45 build the app itself (screens, navigation, design system, voice
UI, state management, and the account/station/event/voice feature set).
Steps 46–50 build the platform-specific audio layer (background playback,
lock-screen/notification controls, interruption handling) that the Steps
39–45 screens depend on for actual playback — covered in Section 8, and
called out explicitly as living **inside** the Flutter client per
`docs/ARCHITECTURE_PLAN.md`'s capability-boundary table, not as a separate
service.

## 2. Technology stack (sourced)

| Concern | Choice | Why / source |
|---|---|---|
| Framework | Flutter (stable channel) | Only mainstream single-codebase framework with first-class Android/iOS/iPadOS/Windows support — the exact platform set this build targets. |
| Navigation | `go_router` | The Flutter team's own officially recommended/maintained routing package for apps with real navigation needs (deep links, nested tab navigation, auth-gated redirects) — not a third-party alternative.[^1] |
| State management | Riverpod (`flutter_riverpod`, code-generated `@riverpod` providers) | The current (2026) default recommendation for new Flutter projects: compile-safe, doesn't depend on `BuildContext`, scales cleanly from simple UI state to async network-backed state without the boilerplate BLoC requires for a codebase this size.[^2] Rejected: BLoC (justified for large multi-team codebases enforcing strict event/state separation — not this app's shape or team size); plain `Provider`/`setState` (insufficient for the async, network-heavy state this app has throughout — every screen below is backed by a live API call). |
| Networking | `dio` (HTTP client) with a single typed `ApiClient` wrapping it | Interceptor support for attaching `Authorization: Bearer <token>` to every request and centralizing the `{status:"error",message}` error envelope into one typed exception, matching the "common language" contract `docs/ARCHITECTURE_PLAN.md` Section 1 already established backend-side. |
| Secure token storage | `flutter_secure_storage` | Encrypts at rest via each platform's own secure store (Android Keystore, iOS/iPadOS Keychain; Windows Credential Locker) rather than plaintext `shared_preferences` — the standard, currently-recommended way to hold a JWT client-side, and the direct mobile-client analog of the Admin Dashboard's own `sessionStorage`-for-JWT posture (Step 31).[^3] |
| Audio playback | `just_audio` + `audio_service` + `audio_session` (+ `audio_service_win` on Windows) | See Section 8 — sourced there in detail. |
| On-device speech-to-text | `speech_to_text` (platform STT) or a fully offline engine (`whisper_kit` / `flutter_whisper.cpp` / a Vosk-backed package) | Already sourced in `docs/ARCHITECTURE_PLAN.md` footnotes B/C; restated in Section 7. |
| Image loading/caching | `cached_network_image` | Station logos and event flyers (Section 6) are remote HTTPS URLs the backend never transforms or resizes — client-side caching and responsive decoding is the client's own responsibility per the Front-End Design Direction's media-handling bar (`docs/BUILD_MANIFEST.md`). |
| Local offline data storage | `drift` (SQLite-based, type-safe) | Backs Section 9.4's offline-first data cache (station directory, favorites, cached event listings) — genuinely relational data (a station has genres/languages, an event has a category), which is exactly Drift's strength over a plain key-value store. Sourced as the current (2026) default recommendation for structured Flutter local persistence, with Hive/Isar explicitly flagged across multiple current sources as community-maintained-only after their original author stepped back — the same "the boring, currently-supported choice over a trendier one" reasoning already applied above picking Riverpod over BLoC.[^6] |

[^1]: "GoRouter is officially recommended by the Flutter team... the recommended choice for most production Flutter apps," per Flutter's own navigation documentation (docs.flutter.dev/ui/navigation) and corroborating 2026 guides (verygood.ventures/blog/routing-best-practices-in-flutter, theflutterk.it.com/blog/flutter-go-router-typed-routes-2026).
[^2]: "For most new Flutter apps in 2026, Riverpod is the default choice; BLoC wins where strict structure and testability matter most" — per multiple current (2026) comparison sources (dev.to/mryadavgulshan/flutter-state-management-riverpod-vs-bloc-in-2026, softaims.com/blog/flutter-state-management-riverpod-bloc-2026, flutterstudio.dev/blog/bloc-vs-riverpod.html).
[^3]: OWASP's Flutter mobile-security guidance and current 2026 sources agree: use `flutter_secure_storage` (Android Keystore / iOS Keychain-backed) for a JWT, never `shared_preferences`, which stores data in plaintext (docs.talsec.app/appsec-articles/articles/owasp-top-10-for-flutter-m3-insecure-authentication-and-authorization-in-flutter; medium.com/@rk0936626/i-found-some-best-ways-to-store-jwt-json-web-token-in-flutter-a72b93e8eba2).
[^6]: Multiple current (2026) comparisons converge on Drift as the default for relational offline data, with Hive and Isar called out as effectively unmaintained by their original author and kept alive only by the community — "maintenance is a feature... treat Isar and original Hive as legacy you migrate off, not platforms you build on" (flutterstudio.dev/blog/offline-first-flutter-drift.html; luci-studio.com/blog/the-flutter-local-database-landscape-in-2026-a-maintenance-first-guide-fe6d267c; dinkomarinac.dev/blog/best-local-database-for-flutter-apps-a-complete-guide).

**One deliberate deviation from generic 2026 JWT advice, stated explicitly so
a future implementer doesn't "fix" it into a bug:** several sources above
recommend pairing a short-lived access token with a refresh token. **This
backend has no refresh-token endpoint** — `POST /v1/auth/login` issues a
single JWT valid for `JWT_EXPIRES_IN` (default 7 days), and there is no
`POST /v1/auth/refresh` or equivalent (confirmed against the full endpoint
list in `backend/README.md`). The client must not invent a refresh flow the
backend doesn't support. See Section 9 for the actual, correct
session-expiry handling this backend's real contract requires: a `401` from
any authenticated endpoint means the token is invalid or expired, full stop
— the client's only correct response is to clear the stored token and
route to the login screen, exactly the same as an explicit logout.

## 3. App architecture

### 3.1 Navigation structure

`go_router` with two navigation shells, matching whether a route requires a
signed-in account:

```
/login                          (public)
/register                       (public)
/forgot-password                (public)
/forgot-password/confirm        (public — reached via the emailed reset link)

/  (ShellRoute: authenticated bottom-nav shell, redirects to /login if no valid token)
  /home                         (Home / Now Playing entry point)
  /stations                     (Station browser)
  /stations/:id                 (Station detail)
  /events                       (Events browser)
  /events/:id                   (Event detail)
  /events/submit                (Submit an event)
  /voice                        (Voice command sheet — see 3.3)
  /profile                      (Profile / account settings)
  /profile/password             (Change password)
```

- **Auth guard**: `go_router`'s top-level `redirect` callback checks a
  Riverpod `authStateProvider` (holds the current token/user or `null`) on
  every navigation — an unauthenticated user hitting any authenticated route
  is redirected to `/login`; an authenticated user hitting `/login`/
  `/register` is redirected to `/home`. This is the same guard shape as the
  Admin Dashboard's `RequireAuth.tsx` (Step 31), adapted to `go_router`'s
  own redirect mechanism instead of a wrapping React component.
- **Deep link**: the password-reset confirmation email (see
  `backend/README.md`'s "Password reset email delivery") links to a web
  fallback today (there is no existing mobile deep-link scheme registered
  backend-side to change) — `/forgot-password/confirm` is reachable by a
  user manually entering the token, or, as a client-side enhancement once a
  real environment can test it, a registered custom URL scheme /
  Universal/App Link that pre-fills the token from the emailed link.
- **Bottom navigation** (4 tabs, matching the Front-End Design Direction's
  "function-first" standard — no more than a thumb-reachable, glanceable
  set): **Home**, **Stations**, **Events**, **Profile**. Voice is not a
  fifth tab — it's a persistent floating action button/mic affordance
  reachable from every authenticated screen (Section 3.3), matching the
  "voice command must be fast/responsive, minimal lag" requirement: a
  user should never navigate away from what they're doing just to issue a
  voice command.

### 3.2 State management shape

Riverpod providers split along the same domain lines the backend already
uses, so a provider's own name maps directly to a backend resource:

- `authProvider` — current token (from `flutter_secure_storage`) + decoded
  user profile (from `GET /v1/me`, Section 6.6). Every other authenticated
  provider depends on this one for its `Authorization` header.
- `stationsProvider` / `rankedStationsProvider(countryId)` /
  `stationDetailProvider(id)` — backed by `GET /v1/stations`,
  `GET /v1/stations/ranked`, `GET /v1/stations/:id` respectively (Section
  6.2).
- `eventsProvider` / `eventDetailProvider(id)` — backed by `GET /v1/events`,
  `GET /v1/events/:id` (Section 6.3).
- `nowPlayingProvider` — the client-local playback state (which station,
  playing/paused/buffering) that Section 8's audio layer publishes and the
  Home screen, mini-player, and voice playback-control intent (Section 7)
  all read from and act on. **This state is entirely client-side** — the
  backend holds no "now playing" concept for any account (confirmed:
  `POST /v1/voice/command`'s `playback_control` intent resolves only
  *which verb* was spoken, per `backend/README.md`'s Voice System section
  — "the backend holds no server-side 'now playing' state to act on...
  this endpoint's only job... is classifying which one was spoken, so the
  client acts on its own local state immediately").
- `voiceCommandProvider` — wraps the on-device STT session and the
  resulting `POST /v1/voice/command` call (Section 7).
- Every list provider follows the same `AsyncValue<T>` (loading / data /
  error) shape Riverpod's own `FutureProvider`/`AsyncNotifier` give for
  free — every screen below has a first-class loading skeleton and error
  state, never a blank screen while a request is in flight or a silent
  failure when one fails (Section 9).

### 3.3 The voice command UI (cross-cutting, not a single screen)

A floating mic button, present on every authenticated screen (per Section
3.1), opens a bottom sheet with three visual states matching the "listening
→ processing → executed" flow the Voice System Requirements in
`docs/BUILD_MANIFEST.md` explicitly call for ("no perceptible desync
between what the user said and what the app does"):

1. **Listening** — an animated waveform/mic indicator while the on-device
   STT engine (Section 7) is actively capturing speech, with a visible
   live partial-transcript caption where the chosen STT package supports
   one (`speech_to_text` does) — the same "in sync" feedback loop a real
   voice assistant gives, so the user always knows the app heard them
   correctly before it acts.
2. **Processing** — a brief, sub-second loading state while the finished
   transcript is sent to `POST /v1/voice/command` and a response comes
   back. Given the endpoint's own documented profile (up to four DB
   queries per call, per `backend/README.md`), this is expected to be
   fast on any reasonable connection — no separate "still working" state
   is needed beyond a spinner.
3. **Executed** — the sheet dismisses and the resolved `intent` drives an
   immediate, visible action (Section 7 maps every intent to its exact
   client behavior) — playback starts, the events list navigates and
   filters, or a `message`-carrying result (from `not_found`/`ambiguous`/
   `unrecognized`/`help`) is shown as a short, dismissible toast/snackbar
   with the response's own `message` text (never a generic "something
   went wrong" — the backend already crafts a specific, user-facing
   message for every one of these intents).

## 4. Design system (Steps 40's Premium Design direction)

Directly implementing `docs/BUILD_MANIFEST.md`'s "Front-End Design
Direction" section, which is binding on all UI work, not just Step 40:

- **Palette**: warm sunset tones (coral/amber accents), ocean blues/teals as
  the primary brand family, vibrant green for success/positive-state
  accents — defined once as a Flutter `ColorScheme`/`ThemeData` extension
  (light and dark variants both — WCAG-contrast-checked in both, per the
  accessibility requirement below) so every screen pulls from the same
  token set rather than hardcoding colors per-widget. This is the same
  "one set of brand tokens, reused everywhere" approach the Admin
  Dashboard already took with its Tailwind `@theme` brand-color block
  (Step 31) — the Flutter client's `ThemeData` is this app's equivalent
  single source of truth.
- **Typography**: a single type scale (display/headline/title/body/label,
  matching Material 3's own scale naming so `ThemeData.textTheme` stays
  idiomatic) with font sizes verified against WCAG minimum/contrast
  guidance per the explicit "WCAG-verified accessibility (font sizes,
  alignment)" requirement.
- **Motion**: every interactive control (buttons, station/event cards, the
  mic button, dropdown/filter menus) gets real hover (desktop/Windows) /
  pressed / loading / focus / disabled / error states — implemented as
  named widget variants or a shared `PremiumButton`/`PremiumCard` component
  library, not ad hoc per-screen styling, so the "strong, animated
  interactive buttons and dropdown menus" requirement is met consistently
  rather than screen-by-screen. Target 60fps+ with no jank on every
  transition, per the Front-End Design Direction's explicit
  production-grade-native-performance bar — achieved by preferring
  implicit `AnimatedContainer`/`AnimatedSwitcher`-style animations over
  manual `AnimationController` plumbing except where a bespoke effect
  (e.g. the voice-listening waveform) genuinely needs one.
- **Media handling**: station `logoUrl` and event `imageUrl` (both
  optional, HTTPS-only per their backend schemas — Sections 6.2/6.3) are
  loaded via `cached_network_image` with an explicit placeholder and
  error-fallback widget (a station/event's own initial-letter avatar,
  never a broken-image icon) — correct, efficient media handling being an
  explicit, named part of the Front-End Design Direction's craft bar
  ("correct and efficient handling of any video/image media... proper
  codecs/formats, responsive image sizing, no unnecessarily bloated
  assets").
- **What to avoid** (directly from the manifest, restated so it's not lost
  in translation to Flutter specifics): no cheap carnival-flyer look, no
  overloaded tourism-site look, no generic Flutter-starter-template
  appearance, no dark-unreadable UI, no random bright colors outside the
  defined palette.

## 5. Authentication screens

All three screens below are thin UI wrappers around endpoints that already
exist and are already fully tested backend-side — there is no new backend
work implied by this section.

### 5.1 Login (`/login`)

- Calls **`POST /v1/auth/login`** — body `{ email, password }`. On `200`,
  response is `{ token, user }`; `user` matches `userSchema`
  (`id, email, displayName, countryId, createdAt, role, roleChangedAt,
  roleChangedByUserId`, per `backend/src/schemas/common.ts`). Store `token`
  in `flutter_secure_storage`, hydrate `authProvider` with `user`, navigate
  to `/home`.
- `401` → the backend returns the exact same message
  (`"Invalid email or password"`) whether the email doesn't exist or the
  password is wrong (Step 03's anti-enumeration design) — the UI must
  surface this one generic message and never imply "no such account" vs.
  "wrong password" itself, or it would defeat the backend's own
  enumeration protection.
- Rate-limited 5/min server-side — a `429` (see Section 9's generic
  rate-limit handling) should read as "too many attempts, try again in a
  moment," not a generic error.

### 5.2 Registration (`/register`)

- Calls **`POST /v1/users`** — body `{ email, password, displayName,
  countryId? }`. `countryId` is optional at the schema level; the UI should
  still offer a country picker backed by **`GET /v1/countries`** (public,
  no auth — "lists the active launch countries") since `countryId` is what
  personalizes genre-only voice commands and event search later (Section
  7) — worth collecting at signup even though not required.
- `400` → invalid email, password outside 8–72 bytes (the client should
  enforce this same 8–72 byte range in its own form validation before
  submitting, both for latency and because bcrypt's own hashing limit is
  the reason for the upper bound — not an arbitrary product decision, so
  the client-side hint should say so), missing/too-long `displayName`, or
  an unknown `countryId`.
- `409` → email already registered — surface as an inline field error on
  the email input, with a link to `/login`.
- On success, the response is `{ user }` (no token — registration does not
  log the user in automatically per the documented contract). Navigate to
  `/login` with the just-registered email pre-filled, rather than assuming
  an auto-login the backend doesn't perform.

### 5.3 Forgot password (`/forgot-password`, `/forgot-password/confirm`)

- `/forgot-password` calls **`POST /v1/auth/password-reset/request`** —
  body `{ email }`. **Always** show the same generic "if that email is
  registered, a reset link has been sent" success message regardless of
  the actual `200` response content — the backend deliberately returns the
  identical response either way (no enumeration), and the client must not
  undermine that by, say, only showing the message conditionally.
  Rate-limited 5/min.
- `/forgot-password/confirm` calls **`POST /v1/auth/password-reset/confirm`**
  — body `{ token, newPassword }`. `400` with the generic message
  `"Invalid or expired reset token"` covers every failure case (invalid,
  expired, already-used, unknown) by design — again, the client shows this
  message verbatim and never tries to guess a more specific one. On
  success (`200`), every session token issued before the reset is
  invalidated server-side (Section 9.2) — if the user reset their password
  while still logged in on this same device, their current stored token is
  now dead too, so the client should clear its stored token and route to
  `/login` regardless of whether it was already logged out.

## 6. Core feature screens

### 6.1 Home (`/home`)

The landing screen after login — a "what's playing / what's happening"
dashboard, not a menu. Composes three already-existing endpoints, no new
backend work:

- **Continue listening / mini-player**: reflects `nowPlayingProvider`
  (client-local, Section 3.2) — if nothing is playing yet, shows a
  "Play your top station" prompt backed by `GET /v1/stations/ranked` for
  the signed-in user's own `countryId` (from `GET /v1/me`, cached in
  `authProvider`) — `?countryId=<user's countryId>&limit=1` for
  `stations[0]`, the exact fallback-chain entry point
  `docs/BUILD_MANIFEST.md`'s Radio Station Quality Ranking requirement
  describes ("a client can try `stations[0]` and automatically fall
  through to the next entry if it fails to play" — see Section 8.3 for
  the actual fallback-on-failure behavior).
- **Upcoming events strip**: `GET /v1/events?countryId=<user's
  countryId>&limit=5` (public route, default excludes concluded events
  per Step 29 — exactly "what's upcoming" with zero extra client-side
  filtering needed), rendered as a horizontally-scrolling card strip
  linking to `/events/:id`.
- **Voice prompt**: a "Try saying 'play reggae'" hint tied to the
  persistent mic button (Section 3.3) — first-run/empty-state only, not
  shown once the user has issued a voice command at least once (a
  client-local flag, no backend field needed).

### 6.2 Stations (`/stations`, `/stations/:id`)

- **Browser (`/stations`)**: `GET /v1/stations` with UI-exposed filters
  mapping 1:1 to the documented query params — `?countryId=`, `?genreId=`,
  `?languageId=` (each a dropdown backed by `GET /v1/genres`/
  `GET /v1/languages`/`GET /v1/countries`, all public), `?q=` (a search
  box, debounced client-side before firing the request), and
  `?limit=&offset=` for pagination (infinite-scroll, appending pages as
  the user scrolls — `pagination.total` from the response tells the UI
  when to stop requesting more). A "Ranked for my country" toggle switches
  the same screen to **`GET /v1/stations/ranked?countryId=&windowHours=&limit=`**
  instead — the two routes are structurally distinct (Section 6.2's
  ranked view has no `genreId`/`languageId`/`q` filters, since ranking is
  a whole-country ordering, not a filtered browse) so the UI presents them
  as two tabs/modes on one screen rather than pretending they're the same
  request with an extra flag.
- Each result renders via `stationSchema`'s real fields
  (`backend/src/schemas/stations.ts`): `name`, `logoUrl` (nullable — falls
  back to an initial-letter avatar per Section 4), `genres`/`languages`
  (hydrated arrays, rendered as chips), and — only on the ranked view —
  the reliability figures the ranking endpoint's own repository computes
  (`getRankedStationsForCountry`; `backend/README.md`'s Step 22 section
  documents the ordering rule but the response itself is still a plain
  `stationSchema` array per `voice.ts`'s `rankedStations: { type:
  ["array","null"], items: stationSchema }` reuse of the same shape — no
  separate "reliability score" field is actually returned to a client,
  only the resulting order, so the UI must not render a numeric score it
  doesn't have).
- **Detail (`/stations/:id`)**: `GET /v1/stations/:id`. `404` (unknown or
  curated-off — identical response either way per Step 17/backend
  design) renders a "this station is no longer available" empty state,
  never a raw error. The primary action is "Play" (Section 8.3); secondary
  info is `description`, `websiteUrl` (opens externally), `genres`/
  `languages`.
- Stations are never created/edited/deactivated from this client —
  `POST`/`PATCH`/`DELETE /v1/stations/:id` are admin-only and already
  served by the Admin Dashboard (Step 32); this client is a read-only
  consumer of the catalog by design.

### 6.3 Events (`/events`, `/events/:id`, `/events/submit`)

- **Browser (`/events`)**: `GET /v1/events` with `?countryId=`,
  `?categoryId=` (backed by `GET /v1/event-categories`, public), `?q=`,
  `?startsAfter=`/`?startsBefore=` (a date-range picker — "this weekend" /
  "today" quick-filter chips computed client-side into the actual ISO
  date-time bounds, mirroring the same relative-date phrases the Voice
  System already resolves server-side for voice input, Section 7),
  `?includePast=true` (an explicit "past events" toggle — default `false`,
  matching the backend's own upcoming-only default per Step 29), and a
  "Near me" mode using the device's own location permission to populate
  `?nearLatitude=&nearLongitude=&radiusKm=` (both coordinates required
  together per the backend's cross-field rule — the UI must never send
  one without the other) — results in this mode render `distanceKm` on
  each card (Step 30) and re-sort nearest-first, which the backend already
  does server-side; the client applies no additional sort.
- Reversed `startsAfter`/`startsBefore` bounds are rejected `400`
  server-side — the client's own date-range picker should structurally
  prevent selecting an end-before-start range rather than relying on the
  server's rejection as the only guard.
- **Detail (`/events/:id`)**: `GET /v1/events/:id`. `404` for
  unknown/pending/rejected (identical, no moderation-state leak) → the
  same "no longer available" empty state as a station detail 404. Renders
  `venue`/`venueAddress`, a map preview if `latitude`/`longitude` are
  present (`null`/`null` together always — never rendered partially),
  `startsAt`/`endsAt`, `imageUrl` (nullable, same fallback pattern as a
  station logo), and `ticketUrl` as an external "Get Tickets" link (this
  API never handles payment or ticketing itself, per
  `backend/README.md`'s Events section — the client must not attempt to
  build any in-app purchase flow around this field).
- **Submit (`/events/submit`)**: `POST /v1/events` — requires only
  authentication, not admin (any signed-in user can submit, per Step 24).
  Body: `{ countryId, title, description?, venue?, venueAddress?,
  latitude?, longitude?, startsAt, endsAt?, imageUrl?, ticketUrl?,
  categoryIds? }` (exact optional/required split per
  `createEventBodySchema`). The submitted event's `status` is never
  client-set — the form has no status field at all, matching the schema's
  own `additionalProperties: false`. On success (`201`), show a clear
  "Your event is pending review" confirmation for a regular user (the
  response's own `status` field tells the client which message to show:
  `"pending"` → review-pending copy, `"approved"` → immediate "your event
  is live" copy for an admin account submitting through this same
  screen). `400` surfaces field-level errors (unknown `countryId`/
  `categoryIds`, `endsAt` not after `startsAt`, a lone `latitude`/
  `longitude`); `409` (`"An event with this title already exists..."` —
  the exact duplicate-detection message, Step 28) should be shown as a
  specific "this looks like a duplicate" inline error, not a generic
  submission failure.
- No admin moderation UI exists in this client by design — moderation is
  the Admin Dashboard's job (Step 33), already built.

### 6.4 Country/genre/category reference data

`GET /v1/countries`, `GET /v1/genres`, `GET /v1/languages`,
`GET /v1/event-categories` are all public, unauthenticated, rarely-changing
lookup lists. The client fetches each once per app session (a simple
Riverpod `FutureProvider` per list, no manual caching layer needed beyond
Riverpod's own provider-lifetime caching) and reuses the result across
every filter dropdown/picker that needs it, rather than re-fetching per
screen.

### 6.5 Profile (`/profile`, `/profile/password`)

- **Profile**: `GET /v1/me` on load; `PATCH /v1/me` for editing
  `email`/`displayName`/`countryId` (at least one field, all optional per
  `updateStationBodySchema`'s sibling shape for `/me`). `409` on an email
  already taken by another account; `400` on invalid input or unknown
  `countryId`. Changing `countryId` here immediately changes which
  country a genre-only voice command or a country-less event search
  personalizes to (Section 7) — worth a short explanatory line in the UI
  next to that field so the connection isn't hidden.
- **Change password (`/profile/password`)**: `POST /v1/me/password` —
  body `{ currentPassword, newPassword }`. `401` if `currentPassword` is
  wrong (shown as a specific "current password is incorrect" field error,
  not a generic failure); `400` if `newPassword` is outside 8–72 bytes
  (same client-side range hint as registration). `204` on success. This
  call invalidates every token issued before it, **including the one this
  same device is currently using** (Section 9.2) — the client must
  immediately clear its stored token and route to `/login` with a "please
  log in with your new password" message after a successful `204`, rather
  than continuing to use the now-dead token and hitting a confusing `401`
  on the very next request.
- **Delete account**: `DELETE /v1/me` — body `{ password }`. `401` if
  wrong; `204` on success → clear stored token, route to `/login`. Gate
  behind an explicit confirmation dialog (the same `ConfirmDialog`
  interaction pattern the Admin Dashboard already established in Step 32,
  reused conceptually here) since this is irreversible.
- **No admin screens** exist in this client. `GET/PATCH /v1/admin/users`
  is Admin Dashboard territory (Step 31) — a regular mobile client has no
  reason to expose role management, and doing so would duplicate what the
  web dashboard already owns.

### 6.6 What `GET /v1/me` returns (used throughout)

Every screen above that reads "the signed-in user's own `countryId`"
depends on the same call, made once at login and refreshed on `PATCH`:
`GET /v1/me` → `{ user }`, `user` matching `userSchema` exactly (`id,
email, displayName, countryId, createdAt, role, roleChangedAt,
roleChangedByUserId`). `role` is present but this client never branches UI
on it — the mobile app has no admin surface (above), so `role` is
effectively inert data here, present only because it's part of the shared
`userSchema` shape every endpoint returning a user reuses (per the "common
language" contract, `docs/ARCHITECTURE_PLAN.md` Section 1).

## 7. Voice command integration (client half of the Voice System bucket)

This is the single most detailed section, since it's the part
`docs/ARCHITECTURE_PLAN.md` most explicitly identified as needing
zero ambiguity: the backend half (Steps 34–38) is fully built and
verified; only the client-side speech-to-text and intent-handling UI
remain.

### 7.1 The on-device STT boundary

Per `docs/ARCHITECTURE_PLAN.md` footnotes B/C (already sourced, restated
here for completeness): the client captures the microphone, runs speech
recognition **entirely on-device**, and sends only the resulting plain-text
transcript to the backend. No audio ever leaves the device. Two real,
current package choices, either is acceptable — pick based on how much
offline capability the product actually needs:

- **`speech_to_text`** — wraps each platform's own native
  recognizer (iOS Speech framework, Android `SpeechRecognizer`). Simpler
  integration, gives a live partial-transcript stream (used for the
  "Listening" UI state in Section 3.3), but generally requires network
  connectivity on the OS side for the highest-accuracy models on some
  platforms/languages.
- **`whisper_kit` / `flutter_whisper.cpp` / a Vosk-backed package** — fully
  offline, on-device model, no network dependency for recognition itself
  (only for the subsequent `POST /v1/voice/command` call) — the better
  choice if "works with no signal" is a real product requirement for this
  platform's target markets.

Either way, the contract with the backend is identical and already fully
specified: a finished, plain-text string, sent as `POST /v1/voice/command`'s
`text` field.

### 7.2 The exact request/response contract

**`POST /v1/voice/command`** (auth required — `Authorization: Bearer
<token>`, rate-limited 30/min server-side):

```
Request:  { "text": "<transcribed phrase>" }   // 1–500 chars
Response: 200 always, except 400 for missing/empty text
```

The `400` case (missing/empty `text`) should never actually be reachable
from this client's own UI — the STT engine only ever hands back a
non-empty final transcript, or the "Listening" sheet is simply dismissed
with no call made at all if the user cancels. If the STT engine ever
returns a whitespace-only transcript, the client should treat that as "not
recognized" locally and skip the network call entirely, rather than
sending an empty command and handling a `400` that a well-formed client
should never trigger.

Response shape (`voiceCommandResponseSchema`, `backend/src/schemas/voice.ts`
— every field always present, all but `intent` nullable):

```ts
{
  intent: "play_station" | "play_ranked" | "playback_control" |
          "search_events" | "help" | "ambiguous" | "not_found" |
          "unrecognized",
  station: Station | null,
  rankedStations: Station[] | null,
  candidates: Station[] | null,
  events: Event[] | null,
  countryId: number | null,
  genreId: number | null,
  categoryId: number | null,
  dateRangeStart: string | null,   // ISO date-time
  dateRangeEnd: string | null,     // ISO date-time
  action: "pause" | "resume" | "stop" | "next" | "previous" | null,
  helpTopics: { category: string; examples: string[] }[] | null,
  message: string | null,
}
```

### 7.3 Exact client behavior per intent

This table is the zero-ambiguity core of the voice integration — every row
is what the client does the instant that intent comes back, no
interpretation left open:

| `intent` | What's populated | Client action |
|---|---|---|
| `play_station` | `station` | Start playback of `station.streamUrl` immediately (Section 8.3) — a single, unambiguous name match. Update `nowPlayingProvider`, show the mini-player. |
| `play_ranked` | `rankedStations` | Start playback of `rankedStations[0]` (the top of the fallback chain — the exact same "try index 0, fall through on failure" behavior Section 8.3 already implements for the Home screen's own ranked-play entry point). Store the full `rankedStations` list in `nowPlayingProvider` so a later playback failure can fall through to `rankedStations[1]`, etc., without a second network call. |
| `playback_control` | `action` | No backend data to act on by design (Section 3.2) — the client calls its own local audio-session method (`pause()`/`resume()`/`stop()`/`skipToNext()`/`skipToPrevious()`, Section 8) matching `action` directly against whatever `nowPlayingProvider` is currently doing. |
| `search_events` | `events`, `dateRangeStart`, `dateRangeEnd` | Navigate to `/events` pre-filtered to exactly this result set (either by passing the already-fetched `events` array directly into the events-list provider's state, or by re-issuing the equivalent `GET /v1/events` query the voice endpoint itself used — passing the data through directly is preferred, it's already fetched and avoids a redundant round trip) — with the resolved date range shown in the screen's own filter chips so the user sees what was actually searched, per `backend/README.md`'s own stated reasoning for always echoing the range back. |
| `help` | `helpTopics` | Render `helpTopics` (category + example phrases) directly in the voice sheet — a static, categorized list, no further request needed. |
| `ambiguous` | `candidates` | Keep the voice sheet open in a "which one did you mean?" state, listing `candidates` (station cards) as tappable options — tapping one starts playback of that station directly (client-side selection, no second `POST /v1/voice/command` call needed since the candidate list already has full `stationSchema` data). |
| `not_found` | `message` | Show `message` (the backend's own specific text, e.g. naming the unresolved country/genre) as a dismissible toast/snackbar in the voice sheet, then close it. |
| `unrecognized` | `message` | Same as `not_found` — show `message`, close the sheet. The client makes no attempt to guess intent beyond what the backend already resolved. |

### 7.4 Personalization dependency

Both `play_ranked` (a bare "play reggae" with no country named) and a
country-less `search_events` ("carnival events" with no country named) are
personalized server-side to the caller's own `countryId` — pulled from
`GET /v1/me` on the backend (per `backend/README.md`'s Voice System
section: "a genre-only command... is personalized to the caller's own
profile `countryId`"). The client does **not** need to pass `countryId` in
the voice request body at all (the schema has no such field —
`voiceCommandBodySchema` is `{ text }` only); this is entirely a backend
concern already handled. The one client-facing implication: if a user's
account has no `countryId` set (it's optional at registration, Section
5.2), a country-less voice command may resolve to `not_found` with a
message asking for a country — worth a one-time prompt in Profile
(Section 6.5) encouraging a user to set their country if voice commands
are visibly failing this way, but this is a UX nicety, not a required
build item.

### 7.5 Rate limiting

30/min server-side (Step 36) — generous for real conversational use (one
command every two seconds) but a rapid-fire sequence of voice commands
(e.g. a user repeatedly retrying a misheard command) can hit it. A `429`
here should surface the same generic rate-limit handling as anywhere else
(Section 9.3) — "please wait a moment" — never a technical error.

## 8. Platform Audio (Steps 46–50)

Per `docs/ARCHITECTURE_PLAN.md`'s capability boundary table, this bucket
"lives inside the Flutter client" — there is no separate backend service
for audio playback (and per the Project Standard, there never will be: "the
user's device connects directly to the radio station's authorized stream
URL; the application never proxies or stores audio"). This section
specifies the client-side audio architecture in full.

### 8.1 Package stack (sourced)

- **`just_audio`** — the playback engine itself: takes a `station.streamUrl`
  directly (an HTTPS live stream URL, per Section 6.2 — no backend
  transcoding or proxying involved at any point) and handles buffering,
  play/pause/stop state, and stream-error events.
- **`audio_service`** — wraps the `just_audio` player so playback survives
  the app being backgrounded, and publishes the lock-screen/notification
  media controls (play/pause/next/previous) on Android and iOS, plus
  headset-button and (where relevant) Android Auto/CarPlay integration.
  This is the current (2026) standard combination for exactly this
  requirement — "the core approach combines just_audio for playback,
  audio_session for audio focus, and audio_service for background hosting
  and media controls."[^4]
- **`audio_session`** — manages the platform audio-focus/category
  negotiation (Section 8.4) that `audio_service` itself relies on.
- **`audio_service_win`** — the Windows-specific platform implementation
  that gives `audio_service` System Media Transport Controls (SMTC)
  integration on Windows specifically (media-key handling, the
  Windows volume-flyout media controls, metadata display) — needed
  because `audio_service`'s own core plugin targets Android/iOS/web/Linux
  natively; Windows requires this separate, actively-maintained companion
  package to get the equivalent lock-screen-style controls.[^5]
- **`just_audio_background`** was considered and rejected in favor of
  `audio_service` directly: it's explicitly documented as the simpler
  option for a single-`AudioPlayer`-instance app, while `audio_service`
  directly is recommended once requirements grow past that (candidate
  fallback-chain switching on health, Section 8.3, is exactly that kind
  of "more complex requirement").[^4]

[^4]: "The recommended approach for 2026 is using the `audio_service`
  package combined with `just_audio`... The core approach combines
  `just_audio` for playback, `audio_session` for audio focus, and
  `audio_service` for background hosting and media controls" — per
  `audio_service`'s own pub.dev page and corroborating current guides
  (suragch.medium.com/background-audio-in-flutter-with-audio-service-and-just-audio,
  copyprogramming.com/howto/flutter-audio-service-play-audio-in-background-when-mobile-screen-is-locked).
[^5]: `audio_service_win` (pub.dev/packages/audio_service_win) — "brings
  System Media Transport Controls (SMTC) support to Windows for the
  popular `audio_service` plugin... rich media notifications, lock screen
  controls, and hardware media key support," actively maintained as of
  this document's research pass.

### 8.2 Background audio and lock-screen controls (the core of Steps 46–50)

- **Background playback**: `audio_service` keeps the `just_audio` player
  running when the app is backgrounded/screen-locked on every platform —
  configured once via `audio_service`'s `AudioServiceConfig` (foreground
  service on Android with a persistent notification, background audio mode
  entitlement on iOS/iPadOS, SMTC session on Windows via
  `audio_service_win`).
- **Media notification / lock screen**: station `name` and `logoUrl` (both
  already present on every `Station` object per Section 6.2) populate the
  `MediaItem`'s title/artwork exactly as-is — no new backend field is
  needed for this; the existing catalog metadata is already sufficient.
- **Media controls**: play/pause/stop map directly onto `audio_service`'s
  own `AudioHandler` callbacks; "next"/"previous" (also two of the five
  `PlaybackAction` values the voice system already resolves, Section 7.3)
  map onto **moving through the current `rankedStations` list** when
  playback started from `play_ranked`/the Home screen's ranked entry
  point, or are simply disabled/hidden when playback started from a
  direct `play_station` single-station selection (there's no "next
  station" to move to from a one-off station pick — the UI should reflect
  that rather than showing a dead control).
- **Headset/hardware buttons**: handled automatically by `audio_service`
  once its `AudioHandler` callbacks are wired — no separate integration
  needed beyond implementing those same callbacks correctly.

### 8.3 The fallback-chain requirement, implemented client-side

`docs/BUILD_MANIFEST.md`'s Radio Station Quality Ranking requirement ("if
[the best station] is unavailable... the app falls through to the
second-best, then third-best") is a **client-side playback behavior**, not
something the backend endpoint itself performs — `GET /v1/stations/ranked`
returns the ordered list once; acting on a live playback failure by
advancing through it is this client's job:

1. Playback is attempted against `rankedStations[0].streamUrl`.
2. `just_audio`/`audio_service` surface a stream error (connection refused,
   404, timeout, or a decode failure) via the player's own error stream.
3. On such an error, **while a ranked list is the active playback source**
   (i.e., playback started from `play_ranked` or the Home screen's ranked
   entry point — never for a direct `play_station` single-station pick,
   where there is no chain to fall through), the client automatically
   advances to `rankedStations[1]`, then `[2]`, and so on, showing a brief
   "switching to the next best station..." toast so the fallback is
   visible rather than a silent, confusing station change.
4. If every entry in the fetched `rankedStations` list fails, show a clear
   "no stations available right now for this filter" empty state rather
   than looping or repeatedly retrying.

This client-side chain is a genuinely new behavior this specification
introduces (not a restatement of an existing backend feature) — it's the
natural, necessary consumer of what `GET /v1/stations/ranked` already
returns, and it's the only way the manifest's own stated requirement
("automatic, ranked fallback chain") is actually realized end-to-end,
since the backend deliberately holds no live "is playback currently
succeeding" signal itself (that's exactly what Section 3.2's
`nowPlayingProvider` is for).

### 8.4 Interruption handling (per-platform, via `audio_session`)

- **Phone calls / other apps requesting audio focus** (Android's
  `AudioManager` focus system, iOS's `AVAudioSession` interruption
  notifications): `audio_session` surfaces these as a unified Dart API
  regardless of platform. On a transient interruption (a notification
  sound, a brief Siri/Assistant activation), pause and auto-resume when
  the interruption ends. On a non-transient interruption (an incoming
  phone call, another app taking exclusive playback), pause and require
  the user to manually resume — auto-resuming through a phone call would
  be actively wrong behavior, not a missing nicety.
- **Bluetooth/headphone disconnect**: pause playback rather than
  continuing over the device's built-in speaker unexpectedly — the
  standard platform-idiomatic behavior on both iOS and Android, and the
  behavior `audio_session`'s own becoming-noisy event exists specifically
  to support.
- **Windows**: `audio_service_win`'s SMTC integration surfaces the
  equivalent system media-session events; the same pause/resume rules
  apply, adapted to whatever interruption classes Windows itself
  surfaces (there is no phone-call-interruption analog on Windows, but a
  system default-audio-device change while streaming should still pause
  rather than silently fail).
- None of this requires any backend involvement — it's purely a
  client-side audio-session concern, which is exactly why
  `docs/ARCHITECTURE_PLAN.md` classified Platform Audio as "native
  per-platform audio-session code, lives inside the Flutter client."

## 9. Error handling and offline considerations

### 9.1 The common error envelope

Every backend error response (any 4xx/5xx) is `{ "status": "error",
"message": string }` — the "common language" contract's Error shape
(`docs/ARCHITECTURE_PLAN.md` Section 1), with no route-specific
exceptions anywhere in this API. The `ApiClient` (Section 2) should
therefore have exactly **one** error-parsing code path for the entire
app: any non-2xx response is deserialized into a single typed
`ApiException(statusCode, message)`, and every screen/provider catches
that one exception type — never a screen-specific error-parsing branch,
since the backend never produces a screen-specific error shape to parse.

### 9.2 Session expiry — no refresh token exists

As stated in Section 2: this backend has no refresh-token endpoint. A
`401` from any authenticated call (`GET /v1/me`, any station/event write,
`POST /v1/voice/command`, etc.) means exactly one thing: the stored token
is missing, malformed, expired (past `JWT_EXPIRES_IN`, default 7 days), or
has been invalidated by a password change/reset (Sections 5.3/6.5) or an
admin-side role change taking effect (irrelevant to this client's own UI,
but the token itself keeps working across a role change — only a password
change/reset invalidates it, per `backend/README.md`'s Token invalidation
section). The **only correct client behavior for any `401`, anywhere in
the app**, is: clear the stored token, reset `authProvider` to signed-out,
and route to `/login` — the same handling as an explicit logout, applied
globally via the `ApiClient`'s single interceptor rather than
re-implemented per screen. There is no retry, no silent re-authentication,
because none is possible without the user re-entering their password.

### 9.3 Rate limiting (`429`)

Global API limit is 100/min per client; `POST /v1/users` is 5/min,
`POST /v1/auth/login`/`password-reset/*`/`POST /v1/me/password`/
`DELETE /v1/me` are each 5/min, `POST /v1/voice/command` is 30/min (all
per `backend/README.md`). A `429` should always render as a short,
friendly "please wait a moment and try again" message — never surfaced as
a raw error — since every one of these limits is deliberately generous for
genuine single-user usage and a `429` in practice means either a real
retry-storm bug in the client (worth investigating, not just swallowing)
or a user rapid-tapping a button, both better served by a calm message
than an alarming one.

### 9.4 Network loss / offline

**Live radio audio is, by definition, not an offline-capable feature** —
a listener's device connects directly to a station's own live stream
(Section 8, the Project Standard's own no-rebroadcast/no-recording rule),
so there is no cached or stored broadcast this client could play back
without a real connection, and it must never claim otherwise. That is the
one hard boundary here. Everything *else* — the station directory, the
user's own favorites, and recently-fetched event listings — is ordinary
reference/list data with no technical reason to become unusable the
moment connectivity drops, so this client is **offline-first for data,
online-only for live audio**, not offline-incapable across the board:

- **What's cached locally** (via `drift`, Section 2): station records
  (name, `logoUrl`, `countryId`, genres, languages, `isActive`, last
  known reachability from the station's own `GET /v1/stations`/
  `/ranked` response — never re-derived or guessed client-side), the
  signed-in user's favorited stations/events (Section 6.1/6.2), a short
  list of recently-played station references (station id + timestamp,
  purely a client-side "recently played" shelf — distinct from the
  server-side `listening_history` table, which this client already
  reports to separately per Section 6), event listings with their dates/
  locations/categories, and the small reference lookups Section 6.4
  already specifies session-caching for. Every write to this local cache
  happens as a side effect of a successful API response — it is a cache
  of what the backend has already confirmed, never a client-invented
  guess, and never anything to do with a station's actual audio stream.
- **Offline behavior**: with no connection, the station directory,
  favorites, and event listings still render from the local cache
  (clearly, not indistinguishably from a live view — see the banner
  below), a station/event detail screen shows its last-known cached
  metadata, and the mini-player/player screen for any station shows a
  clear "an internet connection is required to listen live" state rather
  than a spinner that never resolves or, worse, a misleading "playing"
  state with no actual audio. A persistent, dismissible banner while
  offline states plainly that browsing is from cached data and a
  connection is needed to listen live, with a manual retry/reconnect
  action; the client never auto-hides this banner without confirming
  connectivity has actually returned.
- **What the "no connection" state distinguishes**, since these are
  genuinely different situations a user needs different information
  about: cached data being shown while the device itself has no network
  (this section); a specific station's own stream being unreachable
  while the device is otherwise online (Section 8.3's fallback chain —
  the device has connectivity, the station doesn't); and a stale cache
  that hasn't refreshed in a long time, surfaced as a "last updated
  [time]" label on cached list views so a long-offline user isn't misled
  into thinking a week-old station list is current.
- **Connectivity-aware UI, not a silent hang**: every list screen's
  loading state (Section 3.2's `AsyncValue`) distinguishes "showing
  cached data — still refreshing," "showing cached data — offline," and
  "failed, no cache available yet" (a first-ever launch with no
  connection), each with an appropriate visible affordance rather than
  an indefinite spinner in any of the three cases.
- **Playback resilience**: a genuine network drop mid-playback is treated
  identically to Section 8.3's stream-failure handling — if a ranked list
  is the active source, fall through automatically once connectivity
  returns; a network drop during a direct station play shows a
  "connection lost — tap to retry" state on the mini-player rather than
  silently going quiet. Reconnection is a real retry against the
  station's live stream, exactly as before this correction — never a
  fallback to a cached recording, since none exists.
- **The voice sheet** (Section 3.3) should detect a failed
  `POST /v1/voice/command` call caused by no connectivity (as distinct
  from the backend's own well-formed `not_found`/`unrecognized`
  responses, which always return `200`) and show "no connection" rather
  than misreporting it as the command simply not being understood.
- **Cached reference data**: the lookup lists in Section 6.4 (countries,
  genres, languages, event categories) are small and effectively static —
  caching them for the app session (already specified) means a
  connectivity blip after the first successful fetch doesn't block every
  filter dropdown in the app. Unlike the station/event *directory* data
  above, these session-only lists don't need Drift's persistence — they're
  small enough, and re-fetched often enough (once per app launch), that
  Riverpod's own in-memory provider caching is sufficient on its own.

## 10. Accessibility

Directly required by the Front-End Design Direction ("WCAG-verified
accessibility (font sizes, alignment)"), concretely for this client:

- Every interactive control (Section 4) exposes a real Flutter
  `Semantics` label — including the mic button (e.g. "Voice command,
  double tap to speak") and every media control from Section 8.2, not
  just default widget semantics.
- Color contrast for text-over-image compositions (station/event cards
  with a background photo, Section 4) is verified against WCAG AA
  minimums for both the light and dark theme variants, with a scrim/
  gradient overlay where a photo alone can't guarantee it.
- The voice-command flow (Section 3.3) has a fully usable
  text-input fallback (a text field the user can type a command into
  instead of speaking, which sends the exact same `POST
  /v1/voice/command` call) — both because on-device STT accuracy
  varies and because voice input alone is not an accessible-by-default
  interaction pattern for every user.
- Dynamic type / OS-level text-scaling settings are respected throughout
  (no hardcoded pixel-locked text that ignores the platform's own
  accessibility text-size setting).

## 11. Acceptance criteria for a real Flutter implementation

When a real Flutter/Dart toolchain and at least one device/simulator per
target platform become available, Steps 39–50 are considered actually
**built** (matching the standard every other step in
`docs/BUILD_MANIFEST.md` already meets) only once:

- Every screen in Sections 5–6 is implemented and manually verified against
  the real, running backend (not a mock) — the same "verified against a
  live system" bar every backend step has met, this time with a real
  Flutter app instead of `curl`/`app.inject()`.
- Every row of Section 7.3's intent table is exercised with a real spoken
  command against the real `POST /v1/voice/command` endpoint, on a real
  device with a real microphone.
- Background playback, lock-screen controls, and at least one real
  interruption (an incoming call on a real phone, a Bluetooth
  disconnect) are verified on a real Android device, a real iOS/iPadOS
  device, and Windows.
- The fallback-chain behavior (Section 8.3) is proven against a real
  station whose stream is made to fail on purpose (the same "prove the
  regression, don't just assert it" discipline this whole build has
  applied to every backend step).
- Accessibility (Section 10) is checked with each platform's own
  accessibility inspector (Android Accessibility Scanner / Xcode
  Accessibility Inspector / Windows Narrator), not just visually.
- **Offline data mode verified** (Section 9.4): with the station
  directory, favorites, and event listings already populated once,
  disconnect the device's network entirely and confirm the cached
  station directory, favorites, and cached event information remain
  accessible and clearly marked as cached, while attempting to play any
  station correctly reports that an internet connection is required —
  never a silent hang, and never audio that plays anyway. This is
  deliberately not "kill network, app still works" as an unqualified
  claim — a live radio app cannot honestly claim that for its actual
  audio, only for the cached data around it, and the acceptance check
  above is written to prove exactly that distinction, not paper over it.

Until then, this document stands as the complete brief — not a partial
one — for exactly that work.
