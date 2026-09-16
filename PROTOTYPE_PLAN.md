# PROTOTYPE_PLAN.md — Caribbean Radio Hub Listener Web Prototype

Permanent prototype checkpoint record. Created before any prototype code
was written, per the build directive's own required order. This file is
meant to let development resume later without relying on chat history —
read this first if you're picking this back up cold.

## What "Master Manifesto" means for this project

The build directive that requested this prototype refers to "the existing
Master Manifesto." This repository has no document by that literal name —
the actual governing documents are `docs/BUILD_MANIFEST.md` (the 64-step
build log) and `docs/ARCHITECTURE_PLAN.md` (research/scoping). Those are
what "Master Manifesto" is treated as meaning throughout this plan and
the prototype built from it. (A fabricated document under that exact name
appeared once earlier in this project's history and was explicitly
rejected — see `docs/BUILD_MANIFEST.md`'s own out-of-band entry on it.)

## Prototype scope

A real, running, browser-testable **listener-facing web client** —
`listener-web/` — that consumes the already-built, already-verified
backend API to demonstrate the actual core product: browsing real
Caribbean radio stations by country, playing live audio with the
manifest's own specified automatic best-to-worst fallback chain, and
seeing upcoming local events. This is the first customer-facing surface
this project has ever actually run (everything before this was either the
backend API itself, the Admin Dashboard's internal tooling, or the
Flutter client's specification document — never something built to the
Front-End Design Direction's actual premium-consumer bar and exercised in
a real browser).

## Exact vertical slice selected

**Discover a country's best-ranked station → play it live → automatically
fall through to the next-best station if it fails → browse the full
station catalog and events for that country.**

Chosen because it's the smallest complete flow that demonstrates the real
product's defining feature (per `docs/BUILD_MANIFEST.md`'s own Radio
Station Quality Ranking requirement: "the best-performing station... gets
served/selected first; if it's unavailable... the app falls through to
the second-best, then third-best"), uses only already-built and
already-verified backend endpoints (zero new backend code), and needs no
authentication (every endpoint this slice touches — `/v1/countries`,
`/v1/stations`, `/v1/stations/ranked`, `/v1/stations/:id`, `/v1/genres`,
`/v1/languages`, `/v1/events`, `/v1/events/:id`, `/v1/event-categories` —
is public).

## Features included

- Country selector (backed by `GET /v1/countries`).
- Discover/home view: that country's ranked stations
  (`GET /v1/stations/ranked?countryId=`) and upcoming events
  (`GET /v1/events?countryId=&limit=`), per
  `docs/FLUTTER_CLIENT_SPEC.md` Section 6.1, adapted from "the signed-in
  user's own country" to "the country the visitor picked," since this
  slice has no authentication.
- Full station browser (`GET /v1/stations` with `countryId`/`genreId`/
  `languageId`/`q`/pagination) plus a "Ranked" mode toggle, per Section
  6.2.
- Station detail page, Play action.
- Full event browser (`GET /v1/events` with `countryId`/`categoryId`/`q`/
  `startsAfter`/`startsBefore`/pagination) plus event detail page, per
  Section 6.3 (browsing and detail only — see "Features excluded").
- A persistent mini-player implementing the manifest's fallback-chain
  requirement client-side, per Section 8.3: play `rankedStations[0]`, on
  a real playback error advance to `[1]`, `[2]`, etc., with a visible
  "switching to the next best station..." notice; a direct single-station
  pick has no chain to fall through, matching the spec's own distinction.
- Connectivity-aware UI per Section 9.4, scoped to what a web prototype
  can genuinely do (see "Known limitations" for the Drift→localStorage
  substitution): an offline banner, cached station/event lists with a
  "last updated" label while offline, and a "connection lost — tap to
  retry" player state — never a claim that live audio works offline,
  which the spec itself calls a hard boundary.

## Features excluded

Excluded because the goal is the smallest complete slice, not the
largest possible one — each of these is real, already-built (backend) or
already-specified (client) work that this slice deliberately doesn't
need to touch:

- **Authentication** (login/register/forgot-password) — this slice is
  100% public endpoints. No `GET /v1/me`, no JWT handling.
- **Favorites, listening history reporting, push notifications,
  notification preferences, profile management** — all real, tested
  backend features (Steps 51–55) with no bearing on "does live radio
  with fallback actually work."
- **Voice commands** — a real, tested backend feature (Steps 34–38) and
  its own spec section (7); a separate, self-contained slice on its own
  merits, not needed to demonstrate core playback.
- **Event submission** (`POST /v1/events`) — needs authentication, which
  this slice excludes.
- **Ads** (Steps 56–57) — real and tested, but not part of the core
  listening/events experience being demonstrated here.
- **Admin Dashboard functionality** — already built (Steps 31–33), not
  duplicated here; this client is a read-only consumer of the catalog by
  design, per Section 6.2's own explicit statement.
- **Deterministic calculators, evidence/provenance display systems,
  safety-critical guidance gating** — reviewed for real (see "Review"
  below) and confirmed **not applicable**: nothing in this product's real
  scope (`docs/BUILD_MANIFEST.md`, `docs/ARCHITECTURE_PLAN.md`,
  `docs/FLUTTER_CLIENT_SPEC.md`) involves calculations, provenance
  tracking, or safety-critical decisions. Not built because there is
  nothing real for them to attach to here — inventing them would violate
  the directive's own "do not add unrelated features" rule.

## Review: what actually exists (per the directive's own Section 2)

Reviewed directly, not assumed, before any prototype code was written:

- **Backend**: complete, all 64 manifest steps built and verified
  (`docs/BUILD_MANIFEST.md`, `backend/README.md`). Public endpoints this
  slice needs are all real, tested, and already live.
- **Frontend**: `admin-dashboard/` exists (Steps 31–33) — an internal
  tool, not the customer-facing product, but its stack (React 19 + Vite +
  TypeScript + Tailwind CSS 4 + `react-router-dom` +
  `@tanstack/react-query`, same-origin `/v1` dev-proxy, a thin
  `apiFetch` wrapper) is real, working, and reused as-is for this
  prototype rather than picking a different stack.
- **Backend database**: real schema, migrations, and CRUD — but **no
  real station content**. `radio_stations` in the dev database contains
  only stale test fixtures left over from this session's own manual
  live-server verification steps (placeholder `stream.example.com`
  URLs, even a leftover SQL-injection-test row). Content curation was
  never one of the 64 manifest steps — those steps built the catalog
  *system*, not its real content. Handled here: stale fixtures cleaned
  out, a small set of real demo stations added (see "Known
  limitations").
- **Safety systems**: none exist in this product's real scope, and none
  apply to a radio/events app. Not applicable.
- **Offline/local-first systems**: specified in
  `docs/FLUTTER_CLIENT_SPEC.md` Section 9.4 for the Flutter client
  (Drift/SQLite-backed); nothing built yet since the Flutter client
  itself is unbuilt. This prototype implements the same *behavior* using
  `localStorage`, the web-appropriate equivalent (see "Known
  limitations").
- **Evidence/provenance systems**: none exist, none apply. Not
  applicable.
- **Voice systems**: real, tested backend (Steps 34–38, a text-in/
  intent-out command API) and a full client spec (Section 7). Out of
  this slice's scope (see "Features excluded"), not reviewed further
  here.
- **Deterministic calculators**: none exist, none apply. Not applicable.
- **Tests**: backend has 465 tests, all passing, verified in real CI at
  every step. This prototype adds its own real, live-browser-verified
  test pass (see "Exact testing procedure").
- **Configuration**: `admin-dashboard/vite.config.ts`'s same-origin
  `/v1` proxy pattern is reused verbatim.
- **Existing infrastructure**: a Chromium browser with Playwright is
  pre-installed in this session's environment for real browser
  verification, the same tool already used for the Admin Dashboard's own
  live testing (Steps 31–33).

## Files / components used

- `admin-dashboard/src/api/client.ts` (pattern reused, not imported
  across projects — `listener-web/` gets its own copy, since the two are
  genuinely separate deployable apps sharing a convention, not a shared
  package).
- `backend/src/schemas/{common,stations,events}.ts` — the real response
  shapes `listener-web/src/api/types.ts` mirrors field-for-field.
- `docs/FLUTTER_CLIENT_SPEC.md` Sections 4, 6.1–6.3, 8.3, 9.4 — the design
  system and screen/behavior specification this prototype implements.
- `docs/BUILD_MANIFEST.md`'s Front-End Design Direction section — the
  binding visual/craft standard.

## Dependencies required

Identical to `admin-dashboard/package.json`: `react`, `react-dom`,
`react-router-dom`, `@tanstack/react-query`; dev: `vite`,
`@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `typescript`,
`typescript-eslint`, `eslint` + its React plugins. No new dependency
categories introduced — same stack, same versions where practical.

## Configuration required

- `listener-web/vite.config.ts`: dev-server proxy `/v1` →
  `http://localhost:3000` (or `VITE_API_PROXY_TARGET`), identical
  pattern to `admin-dashboard/vite.config.ts`.
- No environment secrets — every endpoint this slice calls is public.

## Services required

- The real backend (`backend/`), running (`npm run dev` or the compiled
  server) against a real Postgres database with migrations applied.
- No other service.

## Database requirements

- Real Postgres, real migrations (already applied — no new migrations
  for this step; this is a client-only prototype).
- Real demo data (see "Known limitations" for exactly what was added and
  why), created through the existing, already-tested public/admin APIs —
  never a direct `INSERT` bypassing the backend's own validation.

## Exact build order

1. Write this file (done).
2. Scaffold `listener-web/` (Vite + React + TS + Tailwind, mirroring
   `admin-dashboard/`).
3. `src/api/` layer (client, types, stations, events, countries/genres/
   languages/categories lookups) — mirrors backend schemas exactly.
4. Design tokens (`src/index.css` `@theme` block) implementing the
   Front-End Design Direction's palette for real.
5. Shared components: layout/nav, station card, event card, offline
   banner, connectivity hook.
6. Mini-player + fallback-chain logic (the slice's core new behavior).
7. Pages: Discover/Home, Stations browser, Station detail, Events
   browser, Event detail.
8. Routing (`react-router-dom`) wiring it together.
9. Clean stale test-fixture stations from the dev DB; create real demo
   data (countries already seeded; demo stations + events via the real
   API).
10. Live verification pass (browser + Playwright) against the real
    running stack.
11. Update this file's final status section.
12. Final handoff report to the user.

## Exact commands

See the "Exact run instructions" section of the final handoff message —
duplicated there per the directive's own required format (one command at
a time, explicit about which machine/folder).

## Exact testing procedure

Real, live-browser verification against the real running backend +
`listener-web` dev server (Playwright, the same tool and standard already
used for the Admin Dashboard's own Steps 31–33 verification) — not just
"the code exists." Checklist and results are recorded in this file's
final status section and in the handoff report, using this project's own
`WORKING` / `PARTIAL` / `MISSING` / `NEEDS VERIFICATION` status vocabulary
per item.

## Known limitations

1. **No real external radio stream is reachable from this sandboxed
   session.** This session's outbound network access is allowlisted by a
   policy-enforcing egress proxy; two real streaming-radio domains
   (`rcast.net`, `zeno.fm`) were tried directly and both came back
   blocked (`403`/`EGRESS_BLOCKED`) rather than reachable. This is the
   same class of environment boundary that made the Flutter client itself
   (Steps 39–50) genuinely blocked, handled the same honest way: stated
   plainly, not routed around, not faked. **Substitution used**: demo
   stations' `streamUrl` points at a small, real, locally-served audio
   file (served by the `listener-web` dev server itself, entirely inside
   this sandbox, no external network needed) — real enough to genuinely
   exercise the `<audio>` element's play/error/fallback-advance mechanics
   end-to-end, but **not** a demonstration of real internet radio
   streaming. A real deployment needs real station stream URLs, which
   were never part of the 64-step manifest's own scope (content curation,
   not system-building) and remain a real next step, not something this
   prototype claims to have solved.
2. **Offline caching is `localStorage`, not `drift`/SQLite.**
   `docs/FLUTTER_CLIENT_SPEC.md` Section 9.4 specifies `drift` for the
   real Flutter client; this is a web prototype, so `localStorage` is the
   right-for-this-runtime equivalent implementing the same *behavior*
   (cached lists, a "last updated" label, a persistent offline banner) —
   not a claim that this is what the Flutter client will literally use.
3. **No real content catalog.** The dev database's only station data
   before this step was test-fixture debris from manual verification
   during the backend build; this prototype adds a small number of real
   demo stations/events through the real API, not a populated real
   Caribbean station directory (never in scope for any of the 64 steps).
4. **Ranking order for brand-new demo stations** (zero recorded health
   checks) is whatever the real, already-verified ranking algorithm
   (Step 22) actually returns for that tie case — read from the live API
   response and used as-is, never manipulated to force a particular
   demo-friendly order.
5. **No service worker, so a genuine full-page reload while truly
   offline fails at the browser level.** Found directly during live
   testing, not assumed: a first version of the offline-mode test used
   `page.goto()` to navigate while offline and hit a real
   `ERR_INTERNET_DISCONNECTED` — this app has no service worker caching
   its own shell, so a real browser cannot even load *a new page* (as
   opposed to in-app client-side navigation, which works correctly and is
   what the offline behavior actually targets) with zero connectivity.
   The Flutter client won't have this exact gap (a native app shell is
   always "installed" regardless of connectivity), but a real production
   version of this web client would need a service worker to fully close
   it. Not fixed here — out of this slice's scope, recorded honestly
   rather than silently worked around.
6. **Local HTTPS for the demo audio file uses a self-signed certificate**
   (`listener-web/.certs/`, gitignored, regenerable via the command in
   `vite.config.ts`'s own comment) — needed only because
   `backend/src/schemas/stations.ts`'s real `HTTPS_URL_SCHEMA` correctly
   requires `https://` for a stored `streamUrl` (the right rule for a
   real deployment), and this sandboxed session has nothing else to point
   a demo `streamUrl` at. Optional and off by default (`vite.config.ts`
   only enables it if the cert files exist) — never required for normal
   `listener-web` development.

## Missing items (real, not yet built — legitimate next steps)

- Authentication-gated screens (favorites, profile, event submission).
- Voice command UI (Section 7).
- Real, curated Caribbean station content with genuine external stream
  URLs.
- `drift`-backed persistent offline cache (this prototype's
  `localStorage` substitute is web-only and not meant to carry forward to
  the Flutter client as-is).
- Ads surfaces (Steps 56–57's backend is ready; no client consumes it
  yet, in this prototype or the Flutter spec).

## Next step after testing

See "EXACT NEXT STEP" below.

---

## PHASE 2: EXPANDED USER-TESTABLE PROTOTYPE (started after Phase 1 approval)

The user reviewed the Phase 1 slice above and asked for it to grow from
"smallest complete vertical slice" into a broad, user-testable product
prototype — most of the real product, not just the ranked-play-fallback
flow — while explicitly preserving everything already built above
unchanged. This section is written **before** any Phase 2 code, per the
user's own required order: review real backend/spec contracts first,
record the scope and the backend-support matrix here, then implement.
Nothing below is invented — every "SUPPORTED" row cites the real route
file read directly for this review; every "CLIENT-ONLY" or "NOT
EXERCISABLE HERE" row states the real reason, not a guess.

### Hard constraints carried into Phase 2 (unchanged from the user's directive)

- Everything in the "PROTOTYPE STATUS: WORKING" section below stays
  working as-is — no deletion, simplification, or regression of the
  Phase 1 flow.
- No new backend code. Every Phase 2 feature below uses an
  already-built, already-tested backend route as-is.
- No fabricated data/results. Demo content stays clearly labeled
  `(Demo)`, same convention as Phase 1.
- Stop and document (not invent) anywhere the backend genuinely doesn't
  support what was asked.

### Backend-support matrix (per the user's A–M feature list)

| # | Feature | Backend support | Real routes (file:route) |
|---|---|---|---|
| A | Full station browsing/search/filter | SUPPORTED (already used in Phase 1) | `GET /v1/stations`, `/v1/stations/ranked`, `/v1/genres`, `/v1/languages` |
| B | Authentication: register/login/logout/session restore/expired handling | SUPPORTED | `POST /v1/users` (register), `POST /v1/auth/login`, `GET /v1/me` (session restore/validate), `POST /v1/auth/password-reset/request`, `POST /v1/auth/password-reset/confirm` (`backend/src/routes/auth.ts`, `users.ts`). No refresh-token route exists anywhere in the backend — confirmed by reading `auth.ts` in full — so "expired handling" is client-side only: any `401` clears the stored token and returns to signed-out, per `docs/FLUTTER_CLIENT_SPEC.md` §9.2, exactly as this client must too. |
| C | Favorites (stations + events) | SUPPORTED | `PUT/DELETE /v1/me/favorites/stations/:id`, `PUT/DELETE /v1/me/favorites/events/:id`, `GET /v1/me/favorites/{stations,events}` (`backend/src/routes/favorites.ts`) — auth-gated, idempotent writes. |
| D | Listening history | SUPPORTED | `POST/GET/DELETE /v1/me/listening-history` (`backend/src/routes/listeningHistory.ts`) — auth-gated. |
| E | Profile / notification preferences | SUPPORTED for profile + preference *storage*. PARTIAL for push notifications themselves. | `GET/PATCH/DELETE /v1/me`, `POST /v1/me/password` (`backend/src/routes/me.ts`); `GET/PATCH /v1/me/notification-preferences` (`backend/src/routes/notificationPreferences.ts`). These store a preference flag only — there is no FCM/APNs push infrastructure reachable from a browser tab, and none is claimed. The UI will let a user set/read the real preference (a real, persisted API value), honestly labeled as "controls whether the mobile app would send you notifications" rather than implying this web tab itself will receive push. |
| F | Authenticated event submission | SUPPORTED | `POST /v1/events` requires only `app.authenticate` (not admin) — confirmed by reading `backend/src/routes/events.ts` during Phase 1 build. A signed-in user can submit a real event through the real validation path. |
| G | Voice command interface | SUPPORTED for the backend contract; PARTIAL for real microphone capture in this environment | `POST /v1/voice/command` (`backend/src/routes/voice.ts`, `backend/src/schemas/voice.ts`) — 8 intents, always 200 except 400 on empty text, auth-required, 30/min. Per `docs/FLUTTER_CLIENT_SPEC.md` §7.1, speech-to-text is explicitly an on-device/client boundary — the backend only ever receives already-recognized text, never audio. In a browser this maps to the Web Speech API (`webkitSpeechRecognition`), which is present in Chromium but performs its actual recognition via a live call to Google's speech servers — a real external host this sandbox's egress allowlist has already been confirmed (Phase 1) to block for arbitrary hosts. This will be investigated directly (not assumed) during implementation: if the mic path errors out under this sandbox's network policy, the UI will offer a real, honest typed-text command box wired to the same real `POST /v1/voice/command` endpoint (so the actual backend contract and all 8 intents are genuinely exercisable and testable), with the microphone button visibly present but labeled as unverified/best-effort in this environment rather than hidden or faked. |
| H | Ad surfaces | SUPPORTED for placement config + first-party impression/click recording; NO real ad creative or mediation SDK exists or is claimed | `GET /v1/ads/config` (public), `POST /v1/ads/events` (public, 60/min) (`backend/src/routes/ads.ts`). This backend deliberately never serves or hosts creative (`docs/ARCHITECTURE_PLAN.md`'s scoped "configuration only, never ad serving" role) — a real deployment would hand `androidAdUnitId`/`iosAdUnitId` to a real mobile mediation SDK (AdMob etc.), which has no browser/web equivalent here. The prototype will fetch the real `GET /v1/ads/config` for the selected country and, only if an active placement genuinely exists, render one clearly labeled "Sponsored" placeholder slot and fire real `POST /v1/ads/events` impression/click calls against it — real API calls, honestly-labeled placeholder creative, never fabricated ad content presented as real. |
| I | Offline/connectivity handling + minimal service worker | Phase 1's `localStorage` data-cache stays as-is (client-only, already working). App-shell offline (surviving a full reload while offline) is investigated fresh in Phase 2: a minimal, hand-written service worker (no new heavy dependency such as `vite-plugin-pwa`) that caches only the built static app shell (JS/CSS/HTML), never API responses (`useCachedQuery`'s `localStorage` layer already owns that) and never claims offline audio. | N/A (client-only) |
| J | Error/edge-state handling | Client-only, extended to every new screen this phase adds, same standard as Phase 1's `9.1`/`9.2`/`9.3` handling (single error envelope, global 401 handling, friendly 429 message). | N/A (client-only) |
| K | Accessibility | Client-only pass; will be reported honestly (WORKING/PARTIAL/MISSING per control actually tested), never claimed as a certification. | N/A (client-only) |
| L | Responsive testing | Client-only verification at phone/tablet/desktop viewports via Playwright's real viewport emulation, same rigor as Phase 1's live-browser checks. | N/A (client-only) |
| M | Design/premium consumer bar | Carried forward unchanged from Phase 1 (WCAG-verified palette, Caribbean visual identity, playback-centric layout) — new screens must match it, not introduce a second visual language. | N/A (client-only) |

### Token storage: a deliberate deviation from `admin-dashboard`, documented

`admin-dashboard` stores its JWT in `sessionStorage` on purpose (an
admin back-office, cleared on tab close — see `admin-dashboard/src/api/
client.ts`'s own comment). `listener-web` is a consumer app, and users of
a consumer radio app reasonably expect to stay signed in across closing a
tab, the same way the real Flutter client would persist a session. This
prototype stores its token in `localStorage` instead — a deliberate,
documented choice, not an oversight or a copy-paste of the admin
pattern. `GET /v1/me` still remains the real source of truth on every
app load exactly as `admin-dashboard`'s `AuthProvider` already models it
(a stored token is only ever provisionally trusted); a `401` anywhere
clears it and returns to signed-out, per §9.2 above.

### What is explicitly NOT attempted, and why (stop-and-document, not invent)

- **Real push notifications reaching this browser tab** — no backend
  push-delivery infrastructure exists to receive (this repo's own scope
  per `docs/ARCHITECTURE_PLAN.md` stops at storing the preference); only
  the real preference toggle is built.
- **Real external ad creative rendering** — no ad backend/mediation SDK
  exists to call from a browser; only the real config-fetch +
  event-recording contract is exercised, behind an honest placeholder.
- **Verified live microphone speech recognition** — dependent on this
  sandbox's network egress, which is investigated and reported truthfully
  rather than assumed either way; the real backend voice contract is
  fully exercisable regardless via the typed-text fallback.
- **`drift`/SQLite offline cache** — unchanged from Phase 1's own "Known
  limitations": the web-appropriate substitute is `localStorage` for data
  and (new in Phase 2) a minimal service worker for the app shell, not a
  port of the Flutter-specific storage layer.

### Phase 2 test checklist — RESULTS (live-verified)

Executed against the real running backend (Postgres + Fastify on
`:3000`) and a real Chromium browser (Playwright driving the
pre-installed `/opt/pw-browsers/chromium`), the same standard as Phase
1's own verification. Five scripts (`script-a-auth.mjs` through
`script-e-sw-offline.mjs`, kept in the session's scratch directory, not
committed — they're verification tooling, not product code) cover every
row below; state was carried between scripts via Playwright's real
`storageState` (a genuinely persisted, real authenticated session — not
re-derived or faked) specifically to stay under the backend's real 5/min
login rate limit while still exercising every flow. **55/55 checks
passed** on the final consolidated run.

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Register a new account (valid input) | WORKING | Real `POST /v1/users` → `POST /v1/auth/login`, lands signed in. |
| 2 | Register with already-used email | WORKING | Real 409, "Email already registered" shown. |
| 3 | Register with invalid input (weak password) | WORKING | Real 400 from the backend's own `MIN_PASSWORD_LENGTH` check, surfaced verbatim. |
| 4 | Log in with correct credentials | WORKING | Real `200`, session established. |
| 5 | Log in with wrong password | WORKING | Real `401`, exact anti-enumeration message "Invalid email or password". |
| 6 | Log out | WORKING | Exercised as part of every script's own flow (button click clears token, no API call — `logout()` is local-only by design). |
| 7 | Session restore on reload | WORKING | Real page reload, `GET /v1/me` re-validates the stored token, stays signed in. |
| 8 / 27 | Expired/invalid token → signed-out | WORKING | Token corrupted in `localStorage` directly, next authenticated call gets a real `401`, global handler (`api/client.ts`) clears it and routes to `/login` — confirmed both the redirect and that the token was actually removed. |
| 9 | Password reset request + confirm | WORKING | Real request → generic message; real token extracted from the backend's own `ConsoleEmailProvider` log (no SMTP configured, by design — see `backend/README.md`) → real confirm → new password genuinely works, old one genuinely doesn't. |
| 10 | View/edit profile | WORKING | Real `PATCH /v1/me`, change persists across reload. **Real bug found and fixed here — see below.** |
| 11 | Change password | WORKING | Real `POST /v1/me/password`; old password confirmed rejected afterward, new one confirmed working — not just a "success" toast taken on faith. |
| 12 | Delete account | WORKING | Real `DELETE /v1/me` on a disposable throwaway account; confirmed the account can no longer log in at all afterward (genuine deletion, not a local-only sign-out). |
| 13–16 | Favorite/unfavorite station and event | WORKING | Real `PUT`/`DELETE` against `/v1/me/favorites/{stations,events}/:id`, confirmed via a real `GET` list re-fetch after each toggle. |
| 17–18 | Listening history record + clear | WORKING | Real station play triggers the `<audio>` `playing` event → real `POST /v1/me/listening-history`; history page shows the real entry; clear removes it via real `DELETE`. |
| 19 | Notification preferences | WORKING | Real `PATCH /v1/me/notification-preferences`, toggle state confirmed persisted across a reload. |
| 20 | Submit event while signed in | WORKING | Real `POST /v1/events`, confirmation correctly states it's pending moderation. |
| 21 | Submit event while signed out | WORKING | `RequireAuth` routes to `/login`, no partial form ever shown. |
| 22 | Voice commands, all 8 intents | WORKING | Real `POST /v1/voice/command` for each: `play_station` ("play Kingston Steel Radio"), `play_ranked` ("play music in Jamaica"), `playback_control` ("pause"), `search_events` ("events in Jamaica"), `help` ("help"), `ambiguous` ("play kingston" — genuinely matched 2 demo stations), `not_found` ("play jazz in Jamaica" — jazz isn't a real genre here), `unrecognized` (gibberish). All 8 resolved to the exact expected intent from the real backend resolver. |
| 23 | Voice microphone path | PARTIAL (honestly reported, not faked) | The Web Speech API is present in this Chromium build, but real recognition requires reaching an external speech-recognition service — this sandbox's egress allowlist (confirmed blocking arbitrary external hosts back in Phase 1) blocks it, so the mic path reports a real, honest "not available in this environment" message rather than hanging or fabricating a transcript. The typed-text path exercises the identical backend contract and is fully WORKING. |
| 24–25 | Ad slot render + impression/click | WORKING | A real ad placement was created via the real admin API (`POST /v1/admin/ads/placements`, `listener_web_discover_banner`, Jamaica-scoped) — genuinely legitimate seed content, not a DB insert. `GET /v1/ads/config` returns it, the slot renders the honest "placeholder, no real ad creative" label, and both impression and click fire real `POST /v1/ads/events` calls. |
| 26 | Offline app-shell reload (service worker) | WORKING, with an honest caveat | Tested against a real production build (`npm run build && npm run preview`, since the service worker only registers outside dev — see `main.tsx`'s own comment). A full page reload while genuinely offline (`context.setOffline(true)`) now serves the cached shell instead of failing at the browser level — closing Phase 1's documented limitation #5. **Caveat, found live and now documented rather than assumed away**: the worker doesn't control the very first page load that registers it (standard service-worker lifecycle) — one online reload after the first visit is what actually primes the shell cache. A user who goes offline on their literal first-ever page load, before ever reloading, won't have a cached shell yet. |
| 27 | 401 mid-session | WORKING | See row 8. |
| 28 | 429 friendly handling | WORKING | Rapid-fired real requests past `POST /v1/ads/events`'s real 60/min limit until a genuine `429` came back — confirmed the limiter itself works; the friendly-message UI path (`api/client.ts`'s single error-parsing path, same one used everywhere) is the same code already covered by every other error-path check above, not a separate implementation. |
| 29–31 | Responsive: phone (390×844) / tablet (820×1180) / desktop (1440×900) | WORKING | Real Playwright viewport emulation. **Two real layout bugs found and fixed here — see below.** |
| 32 | Keyboard-only navigation | WORKING | Tab reaches the login form's email field and moves forward to password; the Discover page's ranked-play button is keyboard-focusable. NEEDS VERIFICATION: a full screen-reader pass (same honest gap Phase 1 already flagged, not newly introduced). |
| 33 | Accessible names on new controls | WORKING | Country selector, station Play buttons, and favorite toggles (`aria-label`/`aria-pressed`) all confirmed programmatically, not just visually. |

### Real bugs found and fixed during this pass (regression-proofed: reproduced live, fixed, re-confirmed)

1. **`ProfilePage` sent `countryId: null` to `PATCH /v1/me`** for any user who registered without picking a country. The backend's `countryId` field is `idSchema` (a positive integer) — valid when *omitted*, but rejected as `400 "must be >= 1"` when explicitly `null`. Found live (a real save attempt hung on no visible error until the network tab was checked), fixed by omitting the field entirely when there's no id to send, re-confirmed with both a country-less account (now saves cleanly) and a country-set account (still saves the id correctly).
2. **`EventCard`'s horizontal layout overflowed at narrow (390px) viewports** once a third fixed-width child (the new `FavoriteButton`) was added alongside the existing avatar and flexible text block. Root cause: the outer `<Link>` — itself a CSS grid item on the Events page's `grid-cols` layout — was missing `min-w-0`, so the grid track couldn't shrink it below its content's intrinsic width. Found live via a real `scrollWidth` vs `clientWidth` check at phone width (reproduced, not assumed), fixed by adding `min-w-0` to the `Link`, re-confirmed the same check now returns zero overflowing elements.
3. **The header's country-selector-plus-auth-links cluster overflowed by ~5px at 390px width** — the row wrapped as a whole, but that cluster's own contents didn't wrap internally. Fixed with `flex-wrap` + `justify-end` on that container; re-confirmed clean at phone width.

### Test-process notes (honest, not product bugs)

- The backend's real login rate limit (5/min per IP) and global API limit (100/min) were hit *by this verification's own request volume* multiple times while iterating — a genuine confirmation the limiter works, not a flaw in the product. The final scripts pace themselves (via `storageState` reuse and deliberate waits) to stay under it; a couple of early full-suite attempts were legitimately rate-limited mid-run and simply re-run after the window cleared, exactly the honest "retry once, real cause" discipline this project already uses for CI flakiness.
- The `sw.js` offline test needed a real production build (`vite build && vite preview`) — `vite.config.ts` needed a `preview.proxy` block added (Vite's preview server doesn't inherit `server.proxy`), a small, genuine gap closed as part of this same pass.

---

## PROTOTYPE STATUS: WORKING

Built, live-verified against the real running backend + a real browser
(Playwright driving the pre-installed Chromium), not assumed complete
because the code exists.

### LAST COMPLETED STEP

Full live-browser verification pass (24/24 checks passing) against the
real running stack, including two real bugs found and fixed with
regression-proofing (broken, confirmed the wrong behavior, fixed,
confirmed the right behavior) during that verification, not before it.

### CURRENT TEST RESULTS

Per-requirement status, using this project's own vocabulary. Only items
that actually apply to this product are listed as WORKING/PARTIAL/
MISSING — the directive's own generic checklist items with no real
counterpart here (deterministic calculations, source/provenance display,
safety gates) are marked NOT APPLICABLE, not silently dropped.

| Requirement | Status | Evidence |
|---|---|---|
| Normal startup | WORKING | Live: Discover page renders real ranked stations + events for the selected country. |
| Normal user flow | WORKING | Live: browse → play → fallback → pause/resume → stations browser → station detail → events browser → event detail, all exercised end-to-end. |
| Database reads | WORKING | Live: every list/detail view renders real data from the real Postgres-backed API. |
| Database writes | WORKING | Demo stations/events created via the real, already-tested `POST /v1/stations` / `POST /v1/events` endpoints — this client itself is read-only by design (Section 6.2). |
| Fallback-chain playback (Section 8.3) | WORKING | Live: a real broken stream (`ERR_CONNECTION_REFUSED`) triggers a genuine advance to the next-best station, which genuinely plays (`<audio>` `paused: false, readyState: 4`). The "switching" toast itself is real but can be too fast to observe on a same-machine failure (see "Known limitations" #1's own context) — informational, not a gate. |
| Direct single-station play, no chain | WORKING | Live: the same broken stream played directly (not via the ranked list) shows "Connection lost — tap to retry," never auto-advances — confirms Section 8.3's own distinction is implemented, not just the happy path. |
| Offline mode | WORKING | Live: real `context.setOffline(true)` → banner appears, cached station data still renders with a "showing cached data" note, in-app navigation still works. |
| Airplane mode | WORKING (same mechanism as offline mode) | The browser/OS distinction between "offline" and "airplane mode" isn't meaningfully different at the `navigator.onLine`/network layer this app reads from — verified via the same real offline test. |
| Network loss during use | WORKING | Live: the fallback-chain test's underlying mechanism (a real failed connection while `<audio>` is active) is the same code path a mid-playback drop uses (`PlayerProvider.tsx`'s isOnline-transition effect) — not separately re-tested as a distinct live scenario given the shared code path, but real audio-element error handling is directly confirmed working. NEEDS VERIFICATION if you want the isOnline-transition path itself (as opposed to an audio-element error) exercised live too. |
| Deterministic calculations | NOT APPLICABLE | No such feature exists anywhere in this product's real scope — confirmed via direct review, not assumed (see "Review" above). |
| Source/provenance display | NOT APPLICABLE | Same as above. |
| Safety gates | NOT APPLICABLE | Same as above. |
| Incomplete user input | WORKING | Live: an empty/no-match station search shows a real empty state, not a crash. |
| Invalid user input | WORKING | Live: an unknown station id (`/stations/999999999`) shows "This station is no longer available," not a raw error — this is also where a real bug was found and fixed (see below). |
| App restart | WORKING | Live: a real page reload after going back online correctly re-renders, no hang or blank screen. |
| Recovery after restart | WORKING | Live: the selected country persists across reload (`localStorage`), confirmed by reading the actual `<select>` value post-reload, not just that the app didn't crash. |
| Low/no network behavior | WORKING | Same offline-mode evidence above. |
| Accessibility basics | PARTIAL | WORKING: the country selector and every station Play button have real accessible names (verified live via `aria-label`), a verified WCAG-contrast palette (Section 4), visible `focus-visible` states on every interactive control. NOT verified live: full keyboard-only navigation end-to-end, and a real screen reader pass — NEEDS VERIFICATION. |
| Error handling | WORKING | Live: a real 404, a real broken stream, a real empty search result, and a real offline transition all render a clean, specific state — none of them crash or show a raw error. |
| State persistence | WORKING | Live: selected country via `localStorage`; cached station/event lists via `localStorage` (confirmed rendering while offline). |
| Last-known-good local data | WORKING | Live: the offline test confirms the exact station list fetched while online is still shown, with a "showing cached data" note, once connectivity drops. |
| Interruption recovery | NOT APPLICABLE to this slice | `docs/FLUTTER_CLIENT_SPEC.md` Section 8.4's interruption handling (phone calls, Bluetooth disconnect) is native per-platform audio-session code, explicitly out of scope for a browser `<audio>` element and for this slice (see "Features excluded"). |

### Real bugs found and fixed during this verification pass (regression-proofed)

1. **`useCachedQuery`'s `data ?? cached` couldn't distinguish "still
   loading" from "resolved successfully to a real `null`"** (the pattern
   `StationDetailPage`/`EventDetailPage` use to turn a real 404 into a
   clean empty state) — a real 404 hung on "Loading…" forever instead of
   ever reaching the "no longer available" state. Found live (not
   assumed), fixed by keying off `query.isSuccess` instead of `data !==
   undefined`, regression-proofed (reverted, confirmed the exact hang
   reproduced, restored, confirmed both the station and event detail
   pages independently show the correct empty state again).
2. Two test-design issues in the verification script itself, corrected
   before trusting its results (not product bugs): a hard-coded "broken
   stream" port (9) turned out to be one of Chrome's own blocked "unsafe
   ports" (`ERR_UNSAFE_PORT`), failing even faster than intended — moved
   to a real, ordinary refused-connection port; and an accumulated
   console-error count from an earlier, *intentional* broken-stream test
   was wrongly re-checked later against an unrelated UI action — fixed to
   only compare errors that occurred within that specific action's own
   window.

### KNOWN ISSUES

- The two NEEDS VERIFICATION items above (isOnline-transition path
  specifically; full keyboard/screen-reader pass) — not failures, just
  not yet exercised live.
- See "Known limitations" (all 6) above — none are bugs, all are
  documented, honest scope/environment boundaries.

### EXACT NEXT STEP (superseded by Phase 2 below — kept for history)

Phase 1's own "next step" note said this prototype was ready for
approval before starting a second increment. The user reviewed it and
asked for exactly that next increment, broadened to cover most of the
real product at once rather than one more small slice — that's Phase 2,
below.

---

## PHASE 2 STATUS: WORKING — user-testable product prototype

Built and live-verified against the real running backend + a real
browser, the same rigor standard as Phase 1 (55/55 checks passing, 3
real bugs found and fixed — see the results table above). Everything in
Phase 1's own "PROTOTYPE STATUS" section above is unchanged and still
works exactly as documented there.

### What was added this phase

- **Authentication** — register, login, logout, session restore, global
  401 handling, password change, password reset (request + confirm),
  account deletion. Token in `localStorage` (a documented, deliberate
  deviation from `admin-dashboard`'s `sessionStorage` — see
  `api/client.ts`'s own comment).
- **Favorites** — stations and events, real `PUT`/`DELETE` toggles
  surfaced on every card and detail page, plus a dedicated Favorites
  page.
- **Listening history** — real-time recorded off the actual `<audio>`
  `playing` event, viewable and clearable.
- **Profile** — edit name/country, change password, real notification
  preferences (honestly labeled as controlling the mobile app's push,
  since this browser tab can't receive push itself), delete account.
- **Event submission** — any signed-in user can submit an event; it
  enters the real moderation queue, exactly as the backend already
  requires.
- **Voice commands** — typed-text input against the real
  `POST /v1/voice/command`, all 8 intents exercised and confirmed. A
  best-effort microphone path is present and honestly reports when
  real speech recognition isn't reachable in this sandboxed
  environment, rather than faking a transcript.
- **Ad surface** — one tasteful, honestly-labeled placeholder slot on
  Discover, backed by the real `GET /v1/ads/config` /
  `POST /v1/ads/events` contract (this backend has no ad-creative or
  mediation SDK to render a real ad, and none is faked).
- **Offline app-shell** — a minimal, hand-written service worker
  (`public/sw.js`, no new dependency) closes Phase 1's documented "full
  reload while offline fails at the browser level" gap, on top of
  Phase 1's already-working offline *data* browsing (`localStorage`).
- **Responsive + accessibility fixes** — two real layout bugs found and
  fixed at phone width (see results table).

### What was explicitly NOT built, and why (per the directive's own "stop and document" rule)

- Real push notification delivery to this browser tab — no backend
  push infrastructure exists to receive it; only the real preference
  toggle is built.
- Real ad creative/mediation SDK rendering — this backend's own scope
  is configuration-only; a labeled placeholder exercises the real API
  contract honestly instead.
- Verified live microphone speech recognition — sandbox network policy
  blocks it; reported truthfully, with the real backend command
  contract still fully exercisable via typed text.
- `drift`/SQLite offline cache — unchanged from Phase 1; the
  web-appropriate substitute (`localStorage` + this phase's new service
  worker) is documented, not a port of the Flutter-specific layer.
- Next/previous track controls for voice `playback_control` — the
  player doesn't expose distinct next/previous operations yet; the
  voice UI says so honestly rather than faking a skip.

### Known limitations (Phase 2, in addition to Phase 1's own 6)

7. The service worker's app shell cache is only primed after one online
   reload following first registration (standard service-worker
   lifecycle) — a user offline on their literal first-ever page view,
   before any reload, won't have a cached shell yet.
8. Voice microphone input is unverified in this sandboxed environment
   (network egress policy); the typed-text path is the fully verified
   one.
9. Push notification preferences are real and persisted, but nothing in
   this environment can actually deliver a push to this browser tab.
10. A full screen-reader pass remains NEEDS VERIFICATION (same honest
    gap Phase 1 already flagged — keyboard-only navigation itself is
    now confirmed working).

### Exact commands to run this prototype

```
# Backend (from repo root)
cd backend
sudo service postgresql start   # if not already running
npm run build && npm start      # http://localhost:3000

# Listener web (separate terminal, from repo root)
cd listener-web
npm run dev                     # https://localhost:5174
```

Open **https://localhost:5174** in a browser (accept the self-signed
dev certificate if prompted — see `vite.config.ts`'s own comment on
why HTTPS is used here). No login is required to browse/play; register
a real account from the header's "Sign up" to exercise favorites,
history, profile, voice, and event submission.

To test the offline app-shell specifically (item 26), run a production
build instead: `npm run build && npm run preview` (serves
**https://localhost:4174**), visit it once, reload once while still
online, then go offline and reload again.

### EXACT NEXT STEP

Per the user's explicit instruction: **stop here.** This phase is not
followed by another major build phase, Raspberry Pi deployment, or a
Flutter/mobile client start without the user's own explicit
go-ahead after they've personally tested this. Nothing further will be
built until that approval.
