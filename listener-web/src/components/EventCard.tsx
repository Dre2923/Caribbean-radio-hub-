import { Link } from "react-router-dom";
import type { Event } from "../api/types";
import { MediaAvatar } from "./MediaAvatar";

function formatEventDate(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EventCard({ event }: { event: Event }) {
  return (
    <Link
      to={`/events/${event.id}`}
      className="flex gap-4 rounded-xl border border-ocean-100 bg-white p-4 shadow-sm transition hover:border-ocean-400 hover:shadow-md"
    >
      <MediaAvatar src={event.imageUrl} label={event.title} className="h-16 w-16 shrink-0 rounded-lg text-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ocean-900">{event.title}</p>
        <p className="text-sm text-ocean-600">{formatEventDate(event.startsAt)}</p>
        {event.venue && <p className="truncate text-sm text-ocean-500">{event.venue}</p>}
        {event.distanceKm !== null && (
          <p className="mt-1 text-xs font-medium text-success-700">{event.distanceKm.toFixed(1)} km away</p>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {event.categories.slice(0, 3).map((category) => (
            <span
              key={category.id}
              className="rounded-full bg-sunset-50 px-2 py-0.5 text-xs font-medium text-sunset-600"
            >
              {category.name}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
