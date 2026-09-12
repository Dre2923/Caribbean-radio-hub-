// Step 16: near-duplicate detection for radio_stations.stream_url, layered
// on top of the exact-match UNIQUE constraint the column has had since
// Step 12. Two different-looking URLs can be the exact same stream in
// every way that matters to a listener's device - a host typed in a
// different letter case, an incidental trailing slash on the root path -
// and would otherwise both pass an exact-match check and silently create
// two catalog entries for what is really one station. Per RFC 3986 §3.2.2/
// §3.1, scheme and host are case-insensitive but path/query are not, so
// only those two components are case-folded here; a genuine path or query
// difference is treated as a different resource, never folded away.
export function normalizeStreamUrl(streamUrl: string): string {
  let url: URL;
  try {
    url = new URL(streamUrl);
  } catch {
    // Should be unreachable via the HTTP API - createStationBodySchema's
    // format: "uri" plus its HTTPS-only pattern already reject anything
    // this constructor would throw on - but falling back instead of
    // letting the exception propagate keeps this function safe to call
    // from any future caller that isn't sitting behind that same schema.
    return streamUrl.trim().toLowerCase();
  }

  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  // An explicit ":443" on an https:// URL is the same origin as no port at
  // all - folding the default port away means both spellings normalize
  // identically instead of being treated as different hosts.
  const port = url.port && url.port !== "443" ? `:${url.port}` : "";
  // A bare "/" and "" address the same resource for an origin server, so
  // that specific case is folded. Anything beyond it is left untouched:
  // many Icecast/Shoutcast-style stream servers route "/stream" and
  // "/stream/" to different mount points, so a longer path's trailing
  // slash is treated as meaningful, not incidental.
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${scheme}//${host}${port}${path}${url.search}`;
}
