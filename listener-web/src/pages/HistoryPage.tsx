import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { clearListeningHistory, listListeningHistory } from "../api/listeningHistory";
import { MediaAvatar } from "../components/MediaAvatar";
import { useNowPlaying } from "../player/useNowPlaying";

function formatListenedAt(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HistoryPage() {
  const queryClient = useQueryClient();
  const { playSingle } = useNowPlaying();
  const [confirmingClear, setConfirmingClear] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["listening-history"],
    queryFn: listListeningHistory,
  });

  const clear = useMutation({
    mutationFn: clearListeningHistory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listening-history"] });
      setConfirmingClear(false);
    },
  });

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-ocean-900">Listening history</h1>
        {entries.length > 0 &&
          (confirmingClear ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ocean-700">Clear all history?</span>
              <button
                type="button"
                onClick={() => clear.mutate()}
                disabled={clear.isPending}
                className="rounded-full bg-sunset-600 px-3 py-1 font-semibold text-white hover:bg-sunset-500 disabled:opacity-60"
              >
                {clear.isPending ? "Clearing…" : "Yes, clear"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="rounded-full border border-ocean-200 px-3 py-1 font-semibold text-ocean-700 hover:bg-ocean-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              className="text-sm font-semibold text-ocean-600 underline hover:text-ocean-700"
            >
              Clear history
            </button>
          ))}
      </div>

      {isLoading && <p className="text-ocean-600">Loading…</p>}
      {!isLoading && entries.length === 0 && (
        <p className="text-ocean-600">No listening history yet — stations you play will show up here.</p>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-3 rounded-xl border border-ocean-100 bg-white p-3 shadow-sm"
          >
            <MediaAvatar
              src={entry.station?.logoUrl ?? null}
              label={entry.station?.name ?? "?"}
              className="h-10 w-10 shrink-0 rounded-lg text-base"
            />
            <div className="min-w-0 flex-1">
              {entry.station ? (
                <Link to={`/stations/${entry.station.id}`} className="truncate font-medium text-ocean-900 hover:underline">
                  {entry.station.name}
                </Link>
              ) : (
                <span className="truncate font-medium text-ocean-500">Station no longer available</span>
              )}
              <p className="text-xs text-ocean-500">{formatListenedAt(entry.listenedAt)}</p>
            </div>
            {entry.station && (
              <button
                type="button"
                onClick={() => playSingle(entry.station!)}
                className="shrink-0 rounded-full bg-sunset-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sunset-500"
                aria-label={`Play ${entry.station.name}`}
              >
                ▶ Play
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
