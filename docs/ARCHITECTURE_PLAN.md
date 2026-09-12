# Architecture & Sequencing Plan — Steps 27–64

This document exists so that everything built from Step 27 onward is
designed *once*, correctly, against the whole remaining scope — not
invented step-by-step in isolation and then patched to fit together later.
It answers three questions before any more code gets written:

1. What contract ("common language") must every future step speak, so
   nothing needs to be reworked when a later step or a real Flutter client
   consumes it?
2. What actually depends on what, across Steps 27–64 — so the build order
   never creates rework, a dangling dependency, or a conflict?
3. Where does this session's real capability end, and how is that handled
   honestly rather than glossed over?

Every claim below that's an industry/architecture judgment (not just a
restatement of this repo's own prior decisions) was checked against a
current external source rather than asserted from memory — the same
"recall is a hypothesis, never the final answer" standard the Project
Standard already holds licensing claims to. Sources are cited inline.

## 1. The common language: contract rules every future step follows

These are not new rules — they're the patterns Steps 1–27 already
established and proved out repeatedly. Restated here explicitly so a step
built three buckets from now doesn't quietly drift from a convention its
author would otherwise have had to rediscover from scratch by reading old
code.

- **Envelope shape.** A single resource: `{ resourceName: {...} }`. A
  list: `{ resourceNamePlural: [...], pagination: { total, limit, offset } }`.
  Never a bare array, never a differently-shaped pagination object.
- **Error shape.** Always `{ status: "error", message: string }`. Every
  4xx/5xx, no exceptions, no route-specific error shapes.
- **Auth.** `preHandler: [app.authenticate]` for "any signed-in user,"
  `preHandler: [app.authenticate, app.requireAdmin]` for admin-only, in
  that order (requireAdmin depends on request.user, which authenticate
  populates). Role is looked up fresh from the DB on every admin-gated
  request — never trusted from a JWT claim — so a demotion takes effect on
  the very next request, not whenever a stale token expires.
- **Versioning.** Every business route lives under `/v1`. A genuine
  breaking change gets its own `/v2` plugin registered alongside `/v1`,
  never a mutation of `/v1` out from under an existing caller.
- **Search/filter/pagination.** `q` for a case-insensitive `ILIKE`
  substring match (via the shared `escapeLikePattern` pattern), `limit`/
  `offset` with a `DEFAULT_X_LIST_LIMIT`/`MAX_X_LIST_LIMIT` pair, and
  `COUNT(*) OVER()` for the filtered-but-unpaginated total in the same
  round trip. Every additional filter (category, status, date range, etc.)
  composes with every other one via `AND`.
- **Audit-trail triplet.** `xAt` (timestamptz, nullable) / `xByUserId`
  (integer, nullable, FK `users` `ON DELETE SET NULL`) / `xReason` (text,
  nullable) — all three set only as a side effect of the real action
  (never independently editable by the client), all three null until that
  action has actually happened. Established for station deactivation
  (Step 17) and event moderation (Step 27); every future "who did this and
  why" requirement reuses this exact shape rather than inventing a new
  one.
- **Soft-state over hard delete.** A status/active flag that hides
  something from public view while preserving its row and history; `DELETE`
  stays reserved for genuine mistakes/spam, never routine curation.
- **Many-to-many tagging.** A lookup table (seeded, growable via ordinary
  `INSERT`s) plus a junction table with a composite primary key and
  `CASCADE` on both sides — established for genres/languages (Step 13) and
  event categories (Step 25); reused verbatim for any future "tag this
  resource with one or more of a growable set" requirement.
- **Provider abstraction.** A real interface plus a dev-safe default that
  needs no credentials (`ConsoleEmailProvider` vs `SmtpEmailProvider`,
  chosen by whether the relevant `*_HOST`/credential env var is set, with a
  loud startup warning when running on the dev-safe default). Every future
  external-service integration (push notifications, a real ad network, a
  future SMS provider) follows this shape, so the backend is always fully
  testable without live third-party credentials, and swapping in a real
  provider later is a config change, never new application code.
- **Background workers.** `startXWorker()` returns a stop function, uses
  an `unref()`'d `setInterval` (never keeps the process alive on its own),
  and is started/stopped alongside the HTTP server in `index.ts` on
  SIGINT/SIGTERM. A worker's core logic is always a given-a-list pure
  function plus a thin real-catalog-listing wrapper, so tests exercise the
  logic against a small controlled list rather than the shared, ever-
  growing local test database (the fix Steps 18/20/22 already found and
  now design around from the start).
- **Both standing hazards, checked on every step, not just when they bite
  again:**
  - *Deferred-DDL-vs-immediate-query* (`docs/BUILD_MANIFEST.md`'s
    Cross-Cutting Non-Negotiables) — every new migration gets checked for
    mixing `pgm.db.query` with deferred schema-DSL calls in the same `up`/
    `down` function.
  - *Test-database pollution* — the shared local Postgres test database is
    never truncated between local runs; every new listing test either
    filters by a marker unique to that test, or uses the isolated-country-
    plus-`afterEach`-hard-deletion pattern, never an unfiltered exact-
    equality assertion against a listing endpoint.

## 2. Capability boundary — verified, not assumed

This backend-only session has Node.js/TypeScript/Fastify/Postgres, `npm`,
and a pre-installed Chromium + Playwright. It has **no Dart/Flutter SDK, no
iOS/Android toolchain, no simulator/emulator, and no real device** — and
the repository currently contains no client-app directory at all (checked:
`ls` at the repo root shows only `backend/` and `docs/`).

That draws a hard, real line through the remaining buckets:

| Steps | Bucket | Backend-buildable here? |
|---|---|---|
| 27–30 | Events Database (remaining) | Yes — pure backend |
| 31–33 | Admin Dashboard | **Yes** — see below |
| 34–38 | Voice System | Yes, for the backend half — see below |
| 39–45 | Flutter Client & Premium Design | **No** — real Flutter/Dart, real device/simulator testing required |
| 46–50 | Platform Audio | **No** — native per-platform audio-session code, lives inside the Flutter client |
| 51–55 | User Features | Yes — pure backend (see push-notification note below) |
| 56–57 | Advertising | Yes, for the backend half — see below |
| 58–60 | Reliability / Security / Monitoring | Yes — pure backend |
| 61 | Competitor Failure Test Suite | Yes — pure backend (resilience/chaos testing) |
| 62 | Background Update Workers | Yes — pure backend |
| 63 | Production QA | Yes — pure backend |
| 64 | Production Release Gate | Yes — pure backend |

**Admin Dashboard (31–33) is not blocked**, and this is worth stating
explicitly since it would be easy to lump it in with "client work" and
skip it: it's a **web** UI, not a mobile one. Node can build and run a
modern web frontend, and this session's pre-installed Chromium + Playwright
can drive it end-to-end for real, live-browser verification — the same
"verified against a live system" bar every backend step has already met,
just with a browser instead of `curl`. Researched rather than assumed: the
current (2026) battle-tested stack for a lightweight internal dashboard is
React + TypeScript + Vite + Tailwind CSS — Vite specifically recommended
for internal tools/SPAs where build speed matters over SEO or server
rendering.footnote-A It'll be built as a small SPA (served either as
static assets from the existing Fastify app or via its own Vite dev/preview
process during development), consuming only the admin APIs that already
exist (`GET /v1/admin/stations`, `GET /v1/admin/events`, etc.) plus one new
one identified below.

**Voice System (34–38)'s backend half is not blocked either.** Researched
rather than assumed: cloud speech-to-text APIs add 50–500ms of network
round-trip on top of inference time (up to ~2000ms on a poor connection),
while on-device recognition eliminates that round-trip entirely — which is
exactly why on-device processing is the standard architecture where low
perceived latency matters.footnote-B Flutter has real, current packages for
this (`speech_to_text` for platform-level recognition, `whisper_kit`/
`flutter_whisper.cpp`/Vosk-backed packages for fully offline on-device
transcription).footnote-C This means the architecturally correct design —
not just the session's fallback design — has speech-to-text happen
**client-side** (in the eventual Flutter app), with only the resulting
**text** command ever reaching the backend. That makes the backend's
entire Voice System responsibility a text-in, intent-out command
resolution API: no raw audio ever crosses the network, no paid STT
provider credential is needed on the backend at all, and the manifest's
own "fast/responsive, minimal lag, in sync" requirement is best served by
this exact split, not undermined by it. This is fully buildable and
testable here.

**Advertising (56–57)'s backend half is real but narrower than "build an
ad server."** Researched rather than assumed: real mobile ad monetization
runs through a client-side mediation SDK (e.g. AdMob) that itself connects
to multiple ad networks/SSPs; the ad network/mediation layer is what
actually serves creative, tracks impressions/clicks, and handles
payment.footnote-D Building a custom ad-serving/tracking backend from
scratch would be reinventing what a real ad network already does — not a
Fortune-500 engineering choice, an amateur one. The backend's honest,
valuable scope here is: ad **configuration** (which ad unit/placement IDs
are active, per country/screen), **frequency capping** rules, and optional
first-party **placement-level reporting** the mediation SDK's own
dashboard doesn't give a Caribbean-specific view of — all backend-only,
all fully buildable and testable without any real ad network account.

**User Features (51–55)'s push-notification piece is backend-buildable
too**, following the same provider-abstraction pattern as email.
Researched rather than assumed: the standard, secure architecture is
`client → backend → FCM HTTP v1 API → device` (Android direct, iOS via
APNs) with the real service-account credential living only on the server,
never the client, and a device-token registry on the backend that
overwrites on every client-reported refresh (FCM tokens rotate on
reinstall/restore).footnote-E The backend side of this — token
registration endpoint, a `PushProvider` interface mirroring
`EmailProvider`, a dev-safe `ConsoleNotificationProvider` — needs zero
Flutter code to build and fully test; only the eventual client-side
subscription/registration call is blocked.

**The one genuinely blocked segment is Steps 39–50** — the Flutter client
itself and its platform-specific audio-session behavior. For those: this
plan builds a thorough, real architecture/API-contract specification
(screens, state shape, exactly which existing/new backend endpoints back
each screen) rather than writing Dart code that can't be compiled, run on
a simulator, or tested here — writing untested client code and presenting
it as done would fail this build's own standard, not meet it. That
specification becomes the exact brief a real Flutter environment (this
session's follow-up, or a human developer) builds from with zero ambiguity
about what the backend already provides.

## 3. Dependency check across 27–64

Walking the bucket order looking specifically for "does anything later
need something earlier that isn't there yet, or would building in this
order force rework":

- **31–33 Admin Dashboard** consumes the admin listing/moderation
  endpoints already built for stations (Steps 12–18) and events (Steps
  24–27). **One real gap found**: there is currently no admin endpoint to
  list users or change a user's role — `setUserRole`/`getUserRole` exist
  only as repository functions, reachable today solely through the
  `ADMIN_EMAILS` bootstrap allowlist, with no API surface at all. A
  dashboard that manages the platform needs user management alongside
  station/event moderation, so this plan adds it explicitly as part of
  Step 31 rather than discovering the gap mid-dashboard-build.
- **34–38 Voice System**'s backend is a *consumer* of the existing
  station/event search and ranking APIs (Steps 14, 22, 26) to actually
  fulfill a resolved command ("play the news in Jamaica" → the existing
  ranked-stations-by-country-and-category lookup) — no reordering needed,
  those APIs already exist.
- **39–50 (Flutter Client, Platform Audio)** consume every backend API
  built in 12–38 and 51–57 conceptually, but since this plan produces a
  specification rather than running code for these steps, there's no
  build-order hazard — the spec can reference APIs from later buckets
  (51–57) too, since a spec is just documentation, not a compiled
  dependency.
- **51–55 User Features** (favorites, notification preferences, listening
  history) are consumers of stations/events — no new backend dependency
  the earlier buckets don't already satisfy.
- **56–57 Advertising** targets ad configuration by country/placement,
  both of which already exist (countries since Step 02, no new dependency).
- **58–60 Reliability/Security/Monitoring** benefits from being *after*
  every other bucket that adds a route, a worker, or a resource — there's
  more surface to secure/monitor by then, which is exactly why the
  manifest places it late rather than early. No reordering needed.
- **61 Competitor Failure Test Suite** (resilience/chaos testing) needs
  the full system's actual failure modes to exist first — correctly last
  among the feature buckets.
- **62 Background Update Workers** — by this point the codebase has
  several real candidate jobs (a User Features digest, an Advertising
  performance rollup) that didn't exist before Step 51; placing it after
  those buckets, not before, is correct.
- **63 Production QA / 64 Production Release Gate** are inherently
  terminal — nothing to check against yet if they ran earlier.

**Conclusion: the manifest's existing bucket order is architecturally
sound and is not being changed.** The only concrete addition is the
admin user-management endpoint, folded into Step 31.

## 4. Working plan for Steps 27–64

Steps 28–30 (closing out Events Database), 31–33, 34–38 (backend half),
51–64 are each designed and built one at a time, at the same full-rigor
standard as every step so far (migration if needed → repository → routes/
schema → tests → build/lint → migrate up/down/up on dev+test → tests 3×
consecutive → a deliberate regression proven caught and restored →
live-server verification → docs → commit → push → CI confirmation) —
nothing about this plan changes that protocol, it only removes the need to
improvise each step's design in isolation.

Steps 39–50 are built as one thorough architecture/API-contract
specification document (screens/flows, state shape, and the exact backend
endpoint each screen or interaction calls), clearly labeled as a
specification pending a real Flutter environment — not marked "done" in
the sense every other step means it, and not silently skipped either.

---

**Footnotes (sources checked live, not from memory):**

- A. [10+ Best Free React Admin Dashboard Templates for 2026](https://dev.to/vinishbhaskar/free-react-admin-dashboard-templates-5h62); stack-pattern summary from the same search.
- B. [Speech-to-Text Latency: How to Measure and Minimize](https://picovoice.ai/blog/speech-to-text-latency/); [On-device Speech Recognition with Cloud Quality](https://picovoice.ai/blog/on-device-speech-recognition/).
- C. [speech_to_text | Flutter package](https://pub.dev/packages/speech_to_text); [whisper_kit | Flutter package](https://pub.dev/packages/whisper_kit); [Offline Speech Recognition in Flutter](https://medium.com/picovoice/offline-speech-recognition-in-flutter-no-siri-no-google-and-no-its-not-speech-to-text-c960180e9239).
- D. [Ad Mediation: How It Works and Why It Matters](https://www.airbridge.io/en/glossary/ad-mediation); [Mobile ad networks: A guide to maximizing app monetization in 2026](https://www.mobileaction.co/blog/mobile-ad-networks/).
- E. [Setting Up Firebase Cloud Messaging in Flutter](https://medium.com/@karthikv2910/setting-up-firebase-cloud-messaging-in-flutter-a-complete-push-notification-guide-e24c17717f16); [Flutter Push Notifications with FCM — Complete 2026 Walkthrough](https://dev.to/mryadavgulshan/flutter-push-notifications-with-fcm-complete-2026-walkthrough-d5d).
