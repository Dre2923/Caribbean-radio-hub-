import { useParams } from "react-router-dom";
import { getStation } from "../api/stations";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useNowPlaying } from "../player/useNowPlaying";
import { MediaAvatar } from "../components/MediaAvatar";
import { CacheStatusNote } from "../components/CacheStatusNote";
import { ApiError } from "../api/client";
import { FavoriteButton } from "../components/FavoriteButton";
import { useFavoriteStations } from "../hooks/useFavorites";

// docs/FLUTTER_CLIENT_SPEC.md Section 6.2: a 404 (unknown or
// curated-off - identical response either way, Step 17's own design)
// renders a "this station is no longer available" empty state, never a
// raw error.
export function StationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const stationId = Number(id);
  const { playSingle } = useNowPlaying();
  const { enabled: favoritesEnabled, favoritedIds, toggle } = useFavoriteStations();

  const { data, cacheState, cachedAt } = useCachedQuery(["station", stationId], async () => {
    try {
      return await getStation(stationId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  });

  if (cacheState === "failed-no-cache") {
    return <p className="text-sunset-600">Couldn&apos;t load this station.</p>;
  }
  if (data === undefined) {
    return <p className="text-ocean-600">Loading…</p>;
  }
  if (data === null) {
    return <p className="text-ocean-600">This station is no longer available.</p>;
  }

  const { station } = data;

  return (
    <div className="space-y-4">
      <CacheStatusNote cacheState={cacheState} cachedAt={cachedAt} />
      <div className="flex items-start gap-4">
        <MediaAvatar src={station.logoUrl} label={station.name} className="h-24 w-24 shrink-0 rounded-xl text-3xl" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-ocean-900">{station.name}</h1>
            {favoritesEnabled && (
              <FavoriteButton
                isFavorited={favoritedIds.has(station.id)}
                onToggle={() => toggle(station.id)}
                label={station.name}
              />
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {[...station.genres, ...station.languages].map((tag) => (
              <span
                key={`${tag.id}-${tag.name}`}
                className="rounded-full bg-ocean-50 px-2 py-0.5 text-xs font-medium text-ocean-700"
              >
                {tag.name}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => playSingle(station)}
            className="mt-3 rounded-full bg-sunset-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sunset-500 active:scale-95"
          >
            ▶ Play
          </button>
        </div>
      </div>
      {station.description && <p className="text-ocean-800">{station.description}</p>}
      {station.websiteUrl && (
        <a
          href={station.websiteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-ocean-600 underline hover:text-ocean-700"
        >
          Visit website ↗
        </a>
      )}
    </div>
  );
}
