// Minimal, hand-written app-shell service worker - deliberately not
// vite-plugin-pwa or any other precaching build tool, per PROTOTYPE_PLAN.md
// Phase 2's own scoping ("no new heavy dependency"). This closes exactly
// one gap: a full page reload/navigation while genuinely offline, which
// Phase 1's "Known limitations" documented as failing at the browser level
// (ERR_INTERNET_DISCONNECTED) because no service worker existed yet.
//
// What this deliberately does NOT do:
//  - Cache anything under /v1/ (the real API) - useCachedQuery's own
//    localStorage layer already owns "offline-first for data" per
//    docs/FLUTTER_CLIENT_SPEC.md Section 9.4; this worker would only
//    duplicate that with a second, less precise cache.
//  - Cache audio stream requests, or claim offline playback works - "live
//    radio audio is, by definition, not an offline-capable feature"
//    (Section 9.4's own hard boundary). This worker only ever caches the
//    app shell (HTML/JS/CSS/static assets) that renders the UI.
//  - Ship a fixed, build-time precache manifest (the usual approach) -
//    that needs a build plugin to inject real hashed asset filenames,
//    which this deliberately avoids adding. Instead it caches
//    opportunistically at runtime: whatever shell asset a real online
//    visit actually fetches gets cached as a side effect of that real,
//    successful response, the same "cache what's confirmed, never
//    invented" rule useCachedQuery already follows.

const SHELL_CACHE = "crh-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

function isApiRequest(url) {
  return url.pathname.startsWith("/v1/");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only same-origin GETs are ever candidates for shell caching - a
  // cross-origin request or a non-GET (e.g. this app's own POST/PATCH/
  // DELETE API writes) always goes straight to the network untouched.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || isApiRequest(url)) {
    return;
  }

  // Network-first, falling back to whatever was last cached for this
  // exact request - real content wins when online, the last-known-good
  // shell is what's left when it can't be reached, the same
  // "last-known-good local data" posture the rest of this client already
  // uses for station/event lists (useCachedQuery).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // A full-page navigation with nothing cached yet (e.g. the very
        // first visit happened offline) has no shell to fall back to -
        // honestly let it fail rather than serving something wrong.
        throw new Error("No cached shell available for this request while offline.");
      }),
  );
});
