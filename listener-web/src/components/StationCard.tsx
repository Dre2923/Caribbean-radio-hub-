import { Link } from "react-router-dom";
import type { Station, StationReliability } from "../api/types";
import { MediaAvatar } from "./MediaAvatar";
import { FavoriteButton } from "./FavoriteButton";
import { useFavoriteStations } from "../hooks/useFavorites";

export function StationCard({
  station,
  reliability,
  onPlay,
}: {
  station: Station;
  reliability?: StationReliability;
  onPlay: () => void;
}) {
  const { enabled, favoritedIds, toggle } = useFavoriteStations();

  return (
    <div className="flex items-center gap-4 rounded-xl border border-ocean-100 bg-white p-4 shadow-sm transition hover:border-ocean-400 hover:shadow-md focus-within:ring-2 focus-within:ring-ocean-500">
      <MediaAvatar src={station.logoUrl} label={station.name} className="h-14 w-14 shrink-0 rounded-lg text-lg" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/stations/${station.id}`}
          className="block truncate font-semibold text-ocean-900 hover:text-ocean-600 hover:underline"
        >
          {station.name}
        </Link>
        <div className="mt-1 flex flex-wrap gap-1">
          {[...station.genres, ...station.languages].slice(0, 4).map((tag) => (
            <span
              key={`${tag.id}-${tag.name}`}
              className="rounded-full bg-ocean-50 px-2 py-0.5 text-xs font-medium text-ocean-700"
            >
              {tag.name}
            </span>
          ))}
        </div>
        {reliability && reliability.uptimePercentage !== null && (
          <p className="mt-1 text-xs text-ocean-500">
            {Math.round(reliability.uptimePercentage)}% reliable over the last {reliability.windowHours}h
          </p>
        )}
      </div>
      {enabled && (
        <FavoriteButton
          isFavorited={favoritedIds.has(station.id)}
          onToggle={() => toggle(station.id)}
          label={station.name}
        />
      )}
      <button
        type="button"
        onClick={onPlay}
        className="shrink-0 rounded-full bg-sunset-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sunset-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sunset-600 focus-visible:ring-offset-2 active:scale-95"
        aria-label={`Play ${station.name}`}
      >
        ▶ Play
      </button>
    </div>
  );
}
