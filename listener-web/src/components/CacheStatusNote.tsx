import type { CacheState } from "../hooks/useCachedQuery";
import { formatRelativeTime } from "../lib/formatRelativeTime";

// The visible distinction docs/FLUTTER_CLIENT_SPEC.md Section 9.4
// requires every list screen's loading state to make: "showing cached
// data — still refreshing," "showing cached data — offline," and
// "failed, no cache available yet" (a first-ever launch with no
// connection) - never an indefinite spinner standing in for any of the
// three.
export function CacheStatusNote({ cacheState, cachedAt }: { cacheState: CacheState; cachedAt: string | null }) {
  if (cacheState === "live") return null;

  if (cacheState === "refreshing-with-cache") {
    return (
      <p className="text-sm text-ocean-600">
        Showing cached results from {cachedAt ? formatRelativeTime(cachedAt) : "earlier"} — refreshing…
      </p>
    );
  }

  if (cacheState === "offline-with-cache") {
    return (
      <p className="text-sm text-sunset-600">
        Offline — showing cached results from {cachedAt ? formatRelativeTime(cachedAt) : "earlier"}.
      </p>
    );
  }

  return <p className="text-sm text-sunset-600">Couldn&apos;t load — no cached data available yet.</p>;
}
