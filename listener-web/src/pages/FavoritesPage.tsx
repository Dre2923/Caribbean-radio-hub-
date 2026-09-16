import { StationCard } from "../components/StationCard";
import { EventCard } from "../components/EventCard";
import { useFavoriteEvents, useFavoriteStations } from "../hooks/useFavorites";
import { useNowPlaying } from "../player/useNowPlaying";

export function FavoritesPage() {
  const { favorites: favoriteStations, isLoading: stationsLoading } = useFavoriteStations();
  const { favorites: favoriteEvents, isLoading: eventsLoading } = useFavoriteEvents();
  const { playSingle } = useNowPlaying();

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-ocean-900">Your favorites</h1>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ocean-800">Stations</h2>
        {stationsLoading && <p className="text-ocean-600">Loading…</p>}
        {!stationsLoading && favoriteStations.length === 0 && (
          <p className="text-ocean-600">
            No favorited stations yet. Tap the ♡ on any station to add it here.
          </p>
        )}
        <div className="space-y-3">
          {favoriteStations.map(({ station }) => (
            <StationCard key={station.id} station={station} onPlay={() => playSingle(station)} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ocean-800">Events</h2>
        {eventsLoading && <p className="text-ocean-600">Loading…</p>}
        {!eventsLoading && favoriteEvents.length === 0 && (
          <p className="text-ocean-600">No favorited events yet. Tap the ♡ on any event to add it here.</p>
        )}
        <div className="space-y-3">
          {favoriteEvents.map(({ event }) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      </section>
    </div>
  );
}
