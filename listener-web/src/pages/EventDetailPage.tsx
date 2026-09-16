import { useParams } from "react-router-dom";
import { getEvent } from "../api/events";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { MediaAvatar } from "../components/MediaAvatar";
import { CacheStatusNote } from "../components/CacheStatusNote";
import { ApiError } from "../api/client";
import { FavoriteButton } from "../components/FavoriteButton";
import { useFavoriteEvents } from "../hooks/useFavorites";

function formatEventDateRange(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!endsAt) return start;
  const end = new Date(endsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${start} – ${end}`;
}

// docs/FLUTTER_CLIENT_SPEC.md Section 6.3: a 404 for unknown/pending/
// rejected is identical (no moderation-state leak) - the same
// "no longer available" empty state as a station detail 404.
// ticketUrl renders as an external link only - this API never handles
// payment or ticketing itself.
export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const eventId = Number(id);
  const { enabled: favoritesEnabled, favoritedIds, toggle } = useFavoriteEvents();

  const { data, cacheState, cachedAt } = useCachedQuery(["event", eventId], async () => {
    try {
      return await getEvent(eventId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  });

  if (cacheState === "failed-no-cache") {
    return <p className="text-sunset-600">Couldn&apos;t load this event.</p>;
  }
  if (data === undefined) {
    return <p className="text-ocean-600">Loading…</p>;
  }
  if (data === null) {
    return <p className="text-ocean-600">This event is no longer available.</p>;
  }

  const { event } = data;
  const hasLocation = event.latitude !== null && event.longitude !== null;

  return (
    <div className="space-y-4">
      <CacheStatusNote cacheState={cacheState} cachedAt={cachedAt} />
      <MediaAvatar src={event.imageUrl} label={event.title} className="h-48 w-full rounded-xl text-4xl" />
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-ocean-900">{event.title}</h1>
          {favoritesEnabled && (
            <FavoriteButton
              isFavorited={favoritedIds.has(event.id)}
              onToggle={() => toggle(event.id)}
              label={event.title}
            />
          )}
        </div>
        <p className="mt-1 text-ocean-700">{formatEventDateRange(event.startsAt, event.endsAt)}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {event.categories.map((category) => (
            <span
              key={category.id}
              className="rounded-full bg-sunset-50 px-2 py-0.5 text-xs font-medium text-sunset-600"
            >
              {category.name}
            </span>
          ))}
        </div>
      </div>
      {(event.venue || event.venueAddress) && (
        <div>
          {event.venue && <p className="font-semibold text-ocean-900">{event.venue}</p>}
          {event.venueAddress && <p className="text-ocean-700">{event.venueAddress}</p>}
        </div>
      )}
      {hasLocation && (
        <p className="text-sm text-ocean-500">
          Location: {event.latitude!.toFixed(4)}, {event.longitude!.toFixed(4)}
        </p>
      )}
      {event.description && <p className="text-ocean-800">{event.description}</p>}
      {event.ticketUrl && (
        <a
          href={event.ticketUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block rounded-full bg-sunset-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sunset-500"
        >
          Get Tickets ↗
        </a>
      )}
    </div>
  );
}
