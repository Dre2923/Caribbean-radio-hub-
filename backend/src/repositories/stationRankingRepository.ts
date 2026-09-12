import { findStationsByIds, type Station } from "./stationsRepository.js";
import {
  getRankedStationReliabilityForCountry,
  DEFAULT_RELIABILITY_WINDOW_HOURS,
  type StationReliability,
} from "./stationHealthRepository.js";

export interface RankedStation {
  station: Station;
  reliability: StationReliability;
}

// Step 22: the actual per-country quality ranking docs/BUILD_MANIFEST.md's
// "Radio Station Quality Ranking" describes - stations[0] is what a client
// should try to play first; if that fails (or this list is re-fetched
// later and the order has changed as reliability data comes in), the next
// entry is the automatic fallback, and so on.
//
// Two round trips, not one giant query: getRankedStationReliabilityForCountry
// already determines both *which* stations qualify and *what order* they
// rank in from a single aggregation query; findStationsByIds then hydrates
// the full station objects (genres/languages included) for exactly that
// id set in one more round trip - an N+1 (one hydration query per station)
// would be wasteful when the ranking step already knows the whole set
// up front. Postgres's ANY($1) doesn't preserve input order, so the
// ranked order from step one is reapplied here rather than trusted from
// the hydration query.
export async function getRankedStationsForCountry(
  countryId: number,
  windowHours: number = DEFAULT_RELIABILITY_WINDOW_HOURS,
): Promise<RankedStation[]> {
  const ranked = await getRankedStationReliabilityForCountry(countryId, windowHours);
  if (ranked.length === 0) return [];

  const stations = await findStationsByIds(ranked.map((r) => r.stationId));
  const stationsById = new Map(stations.map((station) => [station.id, station]));

  const entries: RankedStation[] = [];
  for (const reliability of ranked) {
    const station = stationsById.get(reliability.stationId);
    // Only a theoretical race (the station was deleted between the two
    // queries above) - skipped rather than thrown, since the rest of the
    // ranking is still perfectly valid and a client falling through this
    // list should never fail outright over one now-gone entry.
    if (station) {
      entries.push({ station, reliability });
    }
  }
  return entries;
}
