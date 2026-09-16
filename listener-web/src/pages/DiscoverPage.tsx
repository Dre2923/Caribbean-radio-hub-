import { useOutletContext } from "react-router-dom";
import { listRankedStations } from "../api/stations";
import { listEvents } from "../api/events";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useDefaultCountry } from "../hooks/useSelectedCountry";
import { useNowPlaying } from "../player/useNowPlaying";
import { StationCard } from "../components/StationCard";
import { EventCard } from "../components/EventCard";
import { CacheStatusNote } from "../components/CacheStatusNote";
import { useQuery } from "@tanstack/react-query";
import { listCountries } from "../api/lookups";
import type { LayoutContext } from "../components/Layout";

// docs/FLUTTER_CLIENT_SPEC.md Section 6.1: "a 'what's playing / what's
// happening' dashboard, not a menu," composing the ranked-stations and
// upcoming-events endpoints - adapted here from "the signed-in user's own
// countryId" to "the visitor's selected country" (see
// hooks/useSelectedCountry.ts's own comment for why).
export function DiscoverPage() {
  const { countryId, setCountryId } = useOutletContext<LayoutContext>();
  const { playRanked } = useNowPlaying();

  const { data: countriesData } = useQuery({ queryKey: ["countries"], queryFn: listCountries });
  useDefaultCountry(countryId, setCountryId, countriesData?.countries[0]?.id);

  const ranked = useCachedQuery(
    ["stations-ranked", countryId],
    () => listRankedStations({ countryId: countryId as number, limit: 5 }),
    { enabled: countryId !== null },
  );
  const events = useCachedQuery(
    ["events-discover", countryId],
    () => listEvents({ countryId: countryId as number, limit: 5 }),
    { enabled: countryId !== null },
  );

  if (countryId === null) {
    return <p className="text-ocean-600">Loading…</p>;
  }

  const rankedStations = ranked.data?.stations ?? [];
  const upcomingEvents = events.data?.events ?? [];

  return (
    <div className="space-y-10">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-ocean-900">Top stations right now</h1>
          {rankedStations.length > 0 && (
            <button
              type="button"
              onClick={() => playRanked(rankedStations)}
              className="rounded-full bg-sunset-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sunset-500 active:scale-95"
            >
              ▶ Play top station
            </button>
          )}
        </div>
        <CacheStatusNote cacheState={ranked.cacheState} cachedAt={ranked.cachedAt} />
        {ranked.cacheState === "failed-no-cache" ? null : rankedStations.length === 0 ? (
          <p className="mt-2 text-ocean-600">No active stations for this country yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {rankedStations.map((entry, index) => (
              <StationCard
                key={entry.station.id}
                station={entry.station}
                reliability={entry.reliability}
                onPlay={() => playRanked(rankedStations.slice(index))}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xl font-bold text-ocean-900">Upcoming events</h2>
        <CacheStatusNote cacheState={events.cacheState} cachedAt={events.cachedAt} />
        {events.cacheState === "failed-no-cache" ? null : upcomingEvents.length === 0 ? (
          <p className="mt-2 text-ocean-600">No upcoming events for this country yet.</p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {upcomingEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
