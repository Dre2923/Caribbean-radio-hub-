import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnlineStatus } from "./useOnlineStatus";

// docs/FLUTTER_CLIENT_SPEC.md Section 9.4's offline-first-for-data
// behavior, implemented for this web prototype with localStorage as the
// right-for-this-runtime substitute for the real Flutter client's
// drift/SQLite cache (see PROTOTYPE_PLAN.md's "Known limitations" for why
// - this is a deliberate, documented substitution, not an attempt to
// half-implement Drift). Every write here happens only as a side effect
// of a real, successful API response - never a client-invented guess,
// the same rule the real spec states for its own cache.

interface CachedEnvelope<T> {
  data: T;
  cachedAt: string;
}

function cacheStorageKey(queryKey: unknown[]): string {
  return `crh-cache:${JSON.stringify(queryKey)}`;
}

function readCache<T>(queryKey: unknown[]): CachedEnvelope<T> | null {
  try {
    const raw = localStorage.getItem(cacheStorageKey(queryKey));
    return raw ? (JSON.parse(raw) as CachedEnvelope<T>) : null;
  } catch {
    // localStorage can throw (private browsing, disabled storage, quota) -
    // a cache read must never crash the page it's trying to help.
    return null;
  }
}

function writeCache<T>(queryKey: unknown[], data: T): void {
  try {
    const envelope: CachedEnvelope<T> = { data, cachedAt: new Date().toISOString() };
    localStorage.setItem(cacheStorageKey(queryKey), JSON.stringify(envelope));
  } catch {
    // Best-effort only - a failed cache write must never fail the request
    // that triggered it.
  }
}

export type CacheState =
  | "live"
  | "refreshing-with-cache"
  | "offline-with-cache"
  | "failed-no-cache";

export interface CachedQueryResult<T> {
  data: T | undefined;
  cacheState: CacheState;
  cachedAt: string | null;
  isOnline: boolean;
  refetch: () => void;
}

export function useCachedQuery<T>(
  queryKey: unknown[],
  queryFn: () => Promise<T>,
  options: { enabled?: boolean } = {},
): CachedQueryResult<T> {
  const isOnline = useOnlineStatus();
  const enabled = options.enabled ?? true;
  const keyString = JSON.stringify(queryKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyString is the real dependency; queryKey is a fresh array/object identity every render
  const cached = useMemo(() => (enabled ? readCache<T>(queryKey) : null), [keyString, enabled]);

  const query = useQuery({ queryKey, queryFn, enabled });

  // query.isSuccess, not `query.data !== undefined` - a query result can
  // legitimately BE null (e.g. StationDetailPage/EventDetailPage's own
  // queryFn resolves a real 404 to null rather than throwing, so the
  // route can render a clean "no longer available" state). `data ??
  // cached` would silently treat that real, successful null answer as
  // "no answer yet" and fall back to a stale cache (or hang on a loading
  // state forever, confirmed directly - a first version of this hook did
  // exactly that against a real 404 before this fix) - isSuccess is the
  // only signal that actually distinguishes "resolved, and the real
  // answer is null" from "hasn't resolved yet."
  useEffect(() => {
    if (query.isSuccess) {
      writeCache(queryKey, query.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same reasoning as the cached memo above
  }, [query.isSuccess, query.data, keyString]);

  const effectiveData = query.isSuccess ? query.data : cached?.data;

  let cacheState: CacheState;
  if (query.isSuccess) {
    cacheState = "live";
  } else if (cached && query.isFetching) {
    cacheState = "refreshing-with-cache";
  } else if (cached) {
    cacheState = "offline-with-cache";
  } else {
    cacheState = "failed-no-cache";
  }

  return {
    data: effectiveData,
    cacheState,
    cachedAt: cached?.cachedAt ?? null,
    isOnline,
    refetch: () => void query.refetch(),
  };
}
