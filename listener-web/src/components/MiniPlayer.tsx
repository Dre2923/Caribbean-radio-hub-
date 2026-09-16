import { useNowPlaying } from "../player/useNowPlaying";
import { MediaAvatar } from "./MediaAvatar";

// The persistent mini-player - always mounted (in Layout.tsx) once
// something has been picked, per docs/FLUTTER_CLIENT_SPEC.md Section
// 3.2's nowPlayingProvider concept. Every status the player state machine
// can be in (PlayerContext.tsx) gets its own real, visible state here -
// never a spinner standing in for "we don't know what to show."
export function MiniPlayer() {
  const { source, status, message, currentStation, togglePlayPause, retry } = useNowPlaying();

  if (!source || !currentStation) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ocean-100 bg-white/95 backdrop-blur px-4 py-3 shadow-[0_-4px_12px_rgba(8,78,92,0.08)]">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <MediaAvatar
          src={currentStation.logoUrl}
          label={currentStation.name}
          className="h-11 w-11 shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ocean-900">{currentStation.name}</p>
          <p
            className={`truncate text-sm ${
              status === "error" || status === "offline-blocked" || status === "exhausted"
                ? "text-sunset-600"
                : "text-ocean-600"
            }`}
            role="status"
          >
            {status === "loading" && "Connecting…"}
            {status === "playing" && "Live now"}
            {status === "paused" && "Paused"}
            {status === "switching" && message}
            {status === "error" && message}
            {status === "offline-blocked" && message}
            {status === "exhausted" && message}
          </p>
        </div>
        {(status === "error" || status === "offline-blocked" || status === "exhausted") && (
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-full border border-sunset-600 px-4 py-2 text-sm font-semibold text-sunset-600 transition hover:bg-sunset-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sunset-600"
          >
            Retry
          </button>
        )}
        {(status === "playing" || status === "paused") && (
          <button
            type="button"
            onClick={togglePlayPause}
            className="shrink-0 rounded-full bg-ocean-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-700 active:scale-95"
            aria-label={status === "playing" ? "Pause" : "Resume"}
          >
            {status === "playing" ? "⏸ Pause" : "▶ Resume"}
          </button>
        )}
        {status === "loading" || status === "switching" ? (
          <span
            className="h-8 w-8 shrink-0 animate-spin rounded-full border-2 border-ocean-200 border-t-ocean-600"
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
}
