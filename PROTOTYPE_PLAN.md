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

### EXACT NEXT STEP

Show this prototype to the user for approval (the handoff report below),
then — only once approved, per the directive's own "do not continue into
the next major build phase until approved" rule — the next real,
well-scoped increment would be either: (a) a second vertical slice adding
authentication + favorites (the next-smallest real addition, reusing
already-built backend endpoints), or (b) closing "Known limitations" #5
with a minimal service worker for real offline app-shell recovery. Do
not start either without the user's explicit go-ahead.
