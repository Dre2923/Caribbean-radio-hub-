// Step 19: real, live reachability checking for a radio station's stream
// URL - the measurement primitive the per-country quality ranking
// (docs/BUILD_MANIFEST.md's "Radio Station Quality Ranking") is built on.
// This connects directly to the station's own stream_url, the same way a
// listener's device would - never a proxy, never a cached/rebroadcast
// copy, consistent with the Project Standard's no-rebroadcast rule.

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
): Promise<StreamHealthCheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(streamUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
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
