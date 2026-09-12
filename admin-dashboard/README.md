# Caribbean Radio Hub — Admin Dashboard

An internal web console for platform admins: manage user accounts today
(Step 31), radio station and event moderation follow in Steps 32-33. Built
as its own project (sibling to `backend/`), consuming only the backend's
existing `/v1/admin/*` API — it has no server of its own and no database
access; every action goes through the same admin-gated endpoints
documented in `backend/README.md`.

## Stack

- **React 19 + TypeScript**, scaffolded with **Vite** — recommended over a
  server-rendered framework (Next.js, Remix) specifically for an internal
  tool/SPA where build speed and iteration matter far more than SEO or
  first-paint performance, which is what a signed-in-only admin console
  actually needs.
- **Tailwind CSS v4** (`@tailwindcss/vite`) for styling — a utility-first
  system chosen over hand-rolled CSS or a heavier component library for
  the same "move fast, stay consistent" reasoning as the framework choice.
- **react-router-dom v7** for client-side routing (`/login`, the
  authenticated `/users` shell, more views as Steps 32-33 land).
- **@tanstack/react-query v5** for server-state (fetching, caching,
  invalidation, mutations) — the current standard for exactly this job
  rather than hand-rolled `useState`/`useEffect` data fetching, which
  reliably reinvents (badly) request de-duplication, background
  refetching, and race-condition handling that a real admin console with
  paginated, filterable lists needs correctly from day one.
- Plain `fetch`, wrapped once in `src/api/client.ts` — no heavier HTTP
  client library is warranted for an API this small.

## Local development

```bash
npm install
npm run dev       # http://localhost:5173, proxies /v1/* to the backend
npm run build      # tsc -b && vite build -> dist/
npm run lint       # ESLint (flat config, mirrors backend/eslint.config.js
                    # plus React-specific rules: react-hooks, react-refresh)
npm run preview    # serves the production build locally
```

The backend (`../backend`) must be running separately (`npm run dev` or
the compiled `dist/index.js`) with at least one account whose email is in
its `ADMIN_EMAILS` allowlist — see `backend/README.md`'s "Authorization:
user roles" section for how the very first admin account gets created.

### Talking to the backend

`vite.config.ts` proxies every `/v1/*` request from the dev server to
`http://localhost:3000` by default (override with `VITE_API_PROXY_TARGET`
if the backend runs elsewhere). This means the dashboard's own code never
hardcodes a backend host — it always calls same-origin `/v1/...` paths, in
both dev (Vite's proxy) and the production static build, where the
deployed web server (nginx, Caddy, or equivalent) is expected to proxy
`/v1/*` to the backend the same way. This also sidesteps ever needing CORS
configuration on the backend for this dashboard.

## Authentication

Signs in through the backend's real `POST /v1/auth/login` — there is no
separate admin credential system. A successful login is checked
client-side for `role === "admin"`; a valid but non-admin account is
turned away with a clear message before ever reaching the dashboard shell.
This check is a UX courtesy only, **never** the actual security boundary —
that is, and can only correctly be, each admin API route's own
server-side `app.requireAdmin` check (`backend/src/app.ts`), which this
dashboard's every request still goes through like any other client.

The issued JWT is kept in `sessionStorage`, not `localStorage` — a
deliberate, session-scoped (cleared when the tab closes) choice for a
console this sensitive (it can grant or revoke admin access), the same
posture a bank's or cloud provider's back-office console typically takes,
rather than the "remember me indefinitely" default appropriate for a
low-stakes consumer app. On load, a stored token is only ever
*provisionally* trusted: `GET /v1/me` is the real check (it might be
expired, or the account might have been demoted/deleted since), the same
"never trust a cached role" principle `app.requireAdmin` itself applies
server-side.

## Pages

- **`/login`** — email/password sign-in.
- **`/users`** (Step 31) — search (`q=`, matches email or display name),
  filter by role, paginated list, and a promote/demote action per row with
  an in-app confirmation dialog. Demoting the last remaining admin
  (including an admin demoting themselves) is rejected by the API with a
  clear `409` — the dashboard surfaces that message rather than special-
  casing it client-side, since the backend's `LastAdminError` check is the
  actual source of truth.

## Verification

Every change to this project has been verified with: a clean
`tsc -b && vite build`, a clean `eslint src` (zero errors *or* warnings —
`react-hooks`'s rules catch real bugs like a stale closure over state
inside an effect, not just style nits), `npm audit`, and a live,
real-browser walkthrough (Playwright against Chromium, driving a real
running backend + dashboard dev server together) covering: an
unauthenticated visit redirecting to `/login`, a wrong password showing
the backend's generic anti-enumeration message, a valid non-admin account
being turned away, a real admin logging in and reaching `/users`,
search narrowing results, promoting and demoting a real account (with the
role-change audit trail visibly updating), the role filter's empty state,
and sign-out correctly revoking dashboard access.

## CI

`.github/workflows/admin-dashboard-ci.yml` runs `npm ci`, the build, the
lint, and `npm audit --audit-level=high` on every push/PR touching
`admin-dashboard/**` — the identical gate `backend-ci.yml` already applies
to the backend.
