import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RankedStation, Station } from "../api/types";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { PlayerContext, type PlayerSource, type PlayerState, type PlayerContextValue } from "./playerContext";

// Implements docs/FLUTTER_CLIENT_SPEC.md Section 8.3's fallback-chain
// requirement client-side, exactly as that section specifies: this is a
// genuinely new client-side behavior, not a restatement of something the
// backend already does - GET /v1/stations/ranked returns the ordered
// list once, and *acting* on a live playback failure by advancing
// through it is this client's own job.
//
// Deliberately not useCallback-memoized: this provider only re-renders on
// its own state changes or a real isOnline transition (both low-
// frequency, real player events, not per-keystroke UI churn elsewhere in
// the app), so there's no real performance cost to redefining these
// functions each render - and doing so sidesteps a genuine conflict
// between this state machine's necessary self-recursion (resolvePlayback
// calls itself once a stream attempt fails) and eslint-plugin-react-hooks
// v7's newer react-hooks/immutability rule, which forbids exactly that
// pattern inside a memoized hook. The recursion itself is ordinary,
// correct JS - it only ever fires asynchronously (a DOM event, a
// timeout), never during the function's own synchronous definition.

function currentStationOf(source: PlayerSource | null): Station | null {
  if (!source) return null;
  return source.kind === "ranked" ? (source.stations[source.index]?.station ?? null) : source.station;
}

// A stream that neither starts playing nor errors within this window is
// treated as failed - the identical bounded-wait discipline
// backend/src/utils/streamHealthCheck.ts already applies server-side
// (Step 19), applied here client-side so a hung connection (as opposed to
// one that errors immediately) still advances the fallback chain rather
// than leaving the player stuck on an indefinite spinner.
const STALL_TIMEOUT_MS = 8_000;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<PlayerState>({ source: null, status: "idle", message: null });
  const isOnline = useOnlineStatus();

  function clearStallTimer() {
    if (stallTimerRef.current !== null) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }

  // Covers both "start playing this source fresh" (mode "fresh") and
  // "this source just failed, advance the chain and try the next entry"
  // (mode "advance").
  function resolvePlayback(source: PlayerSource, mode: "fresh" | "advance") {
    let target = source;

    if (mode === "advance") {
      clearStallTimer();
      if (source.kind === "single") {
        // No chain to fall through for a direct single-station pick -
        // Section 8.3's own explicit distinction.
        setState({ source, status: "error", message: "Connection lost — tap to retry." });
        return;
      }
      const nextIndex = source.index + 1;
      if (nextIndex >= source.stations.length) {
        setState({ source, status: "exhausted", message: "No stations available right now for this filter." });
        return;
      }
      target = { ...source, index: nextIndex };
    }

    const station = currentStationOf(target);
    if (!station) {
      setState({ source: target, status: "exhausted", message: "No stations available right now for this filter." });
      return;
    }
    if (!isOnline) {
      setState({
        source: target,
        status: "offline-blocked",
        message: "An internet connection is required to listen live.",
      });
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    clearStallTimer();
    // "switching" (mode "advance") keeps its own visible toast message
    // through the attempt below, rather than being immediately
    // overwritten by "loading" in the same synchronous update - Section
    // 8.3's own requirement that the fallback is genuinely visible, not a
    // silent, confusing station change.
    setState(
      mode === "advance"
        ? { source: target, status: "switching", message: "Switching to the next best station…" }
        : { source: target, status: "loading", message: null },
    );
    audio.src = station.streamUrl;
    audio.play().catch(() => resolvePlayback(target, "advance"));
    stallTimerRef.current = setTimeout(() => resolvePlayback(target, "advance"), STALL_TIMEOUT_MS);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlaying = () => {
      clearStallTimer();
      setState((prev) => ({ ...prev, status: "playing", message: null }));
    };
    const onError = () => {
      setState((prev) => {
        if (prev.source) resolvePlayback(prev.source, "advance");
        return prev;
      });
    };
    const onPause = () => {
      setState((prev) => (prev.status === "playing" ? { ...prev, status: "paused" } : prev));
    };

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("error", onError);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("pause", onPause);
    };
  });

  // A genuine network drop mid-playback is treated identically to a
  // stream failure (Section 9.4's own "playback resilience" rule) - for a
  // ranked source this means falling through the chain the moment
  // connectivity returns, never silently going quiet.
  const wasOnline = useRef(isOnline);
  useEffect(() => {
    if (wasOnline.current && !isOnline && state.status === "playing" && state.source) {
      resolvePlayback(state.source, "advance");
    }
    wasOnline.current = isOnline;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally reacts only to isOnline transitions
  }, [isOnline]);

  function playRanked(stations: RankedStation[]) {
    resolvePlayback({ kind: "ranked", stations, index: 0 }, "fresh");
  }

  function playSingle(station: Station) {
    resolvePlayback({ kind: "single", station }, "fresh");
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio || !state.source) return;
    const source = state.source;
    if (state.status === "playing") {
      audio.pause();
    } else if (state.status === "paused") {
      audio.play().catch(() => resolvePlayback(source, "advance"));
    }
  }

  function retry() {
    if (state.source) resolvePlayback(state.source, "fresh");
  }

  const value = useMemo<PlayerContextValue>(
    () => ({
      ...state,
      currentStation: currentStationOf(state.source),
      playRanked,
      playSingle,
      togglePlayPause,
      retry,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the functions above close over `state`/`isOnline` fresh every render (deliberately not memoized, see this file's header comment), so `state` is the only dependency that actually needs to trigger a new context value
    [state],
  );

  return (
    <PlayerContext.Provider value={value}>
      <audio ref={audioRef} />
      {children}
    </PlayerContext.Provider>
  );
}
