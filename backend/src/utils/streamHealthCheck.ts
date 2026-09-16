// Step 19: real, live reachability checking for a radio station's stream
// URL - the measurement primitive the per-country quality ranking
// (docs/BUILD_MANIFEST.md's "Radio Station Quality Ranking") is built on.
// This connects directly to the station's own stream_url, the same way a
// listener's device would - never a proxy, never a cached/rebroadcast
// copy, consistent with the Project Standard's no-rebroadcast rule.

import { assertPublicHostname } from "./ssrfProtection.js";

// Step 58/OWASP API7: a small, bounded manual redirect loop rather than
// fetch's own redirect: "follow" - each hop's hostname is re-validated
// against ssrfProtection.ts before being followed, closing the specific
// bypass a single up-front check alone would miss (a station's streamUrl
// that itself resolves to a public address but 302s to an internal one).
// 5 mirrors the conventional default most HTTP clients use for automatic
// redirect-following.
const MAX_REDIRECTS = 5;

export interface StreamHealthCheckResult {
  isReachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

// Generous enough that a real, working stream server under normal load
// isn't wrongly flagged unreachable, short enough that a batch of checks
// across the whole catalog (Step 20) can't stall on one dead one.
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 8000;

// A live radio stream is, by design, a connection that can keep sending
// audio data forever - reading its body to completion (or even waiting for
// it to end on its own) would never return. This function only needs to
// know whether the server responds and with what status, so it always
// issues a plain GET (many real Icecast/Shoutcast-style stream servers
// don't reliably support HEAD) and cancels the response body immediately
// after the headers arrive, before any audio data is read - releasing the
// connection without ever downloading a byte of the actual stream.
export async function checkStreamHealth(
  streamUrl: string,
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  // Defaults to the real SSRF guard; injectable for the identical
  // dependency-injection reason already applied to FcmPushProvider's
  // FetchLike parameter - this codebase's own integration tests point
  // deliberately at real local (loopback) HTTP servers to exercise real
  // sockets, which the real guard correctly refuses by default in
  // production. Only tests override this; every real call site
  // (routes/stationHealth.ts, stationHealth/healthCheckWorker.ts) always
  // uses the real default.
  validateHostname: (hostname: string) => Promise<void> = assertPublicHostname,
): Promise<StreamHealthCheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    let currentUrl = streamUrl;
    let response: Response;
    for (let redirectCount = 0; ; redirectCount++) {
      await validateHostname(new URL(currentUrl).hostname);
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      // Unlike a browser's fetch() (which returns an opaque, unreadable
      // response for a manual-mode redirect, a same-origin-policy
      // protection with no meaning in a server context), Node's own
      // fetch/undici implementation exposes the real status and headers
      // even in "manual" mode - confirmed directly against a real local
      // redirecting server during this step's own verification, not
      // assumed from browser-fetch behavior.
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (!isRedirect || !location) break;
      if (redirectCount >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS}) resolving stream URL`);
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = new URL(location, currentUrl).toString();
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    // Release the connection without reading any of the (potentially
    // endless) stream body. Cancelling can itself throw if the underlying
    // connection is already gone by this point - harmless either way,
    // since the response's own status has already been captured above.
    await response.body?.cancel().catch(() => undefined);

    return {
      isReachable: response.ok,
      statusCode: response.status,
      latencyMs,
      error: null,
    };
  } catch (err) {
    return {
      isReachable: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
