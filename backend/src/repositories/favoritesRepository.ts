// User Features (Step 51+): favorites. A user can favorite any number of
// stations and events; each is a plain many-to-many junction table
// (user_favorite_stations/user_favorite_events, migration
// 1700000019000_user_favorites) - the same shape already established for
// station_genres/station_languages (Step 13) and
// event_category_assignments (Step 25), just between a user and a
// resource instead of between two resources.

import { query } from "../db/pool.js";
import { findStationsByIds, type Station } from "./stationsRepository.js";
import { findEventsByIds, type Event } from "./eventsRepository.js";

export const DEFAULT_FAVORITE_LIST_LIMIT = 50;
export const MAX_FAVORITE_LIST_LIMIT = 100;

const FOREIGN_KEY_VIOLATION = "23503";

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// Raised only in the narrow race window between routes/favorites.ts's own
// existence/visibility check (mirroring GET /v1/stations/:id's "unknown or
// curated-off" 404) and this insert actually committing - e.g. the station
// was deleted by another request in between. The route maps this back to
// the same 404 its own pre-check would have produced, rather than letting
// an unhandled foreign-key violation fall through as a 500.
export class FavoriteStationNotFoundError extends Error {
  constructor(stationId: number) {
    super(`No station with id ${stationId}`);
    this.name = "FavoriteStationNotFoundError";
  }
}

export class FavoriteEventNotFoundError extends Error {
  constructor(eventId: number) {
    super(`No event with id ${eventId}`);
    this.name = "FavoriteEventNotFoundError";
  }
}

// Idempotent by design (ON CONFLICT DO NOTHING on the composite primary
// key) - favoriting an already-favorited station is a no-op success, not
// a 409. A favorite is a simple boolean preference from the caller's own
// point of view ("is this one of mine or not"), not a resource with its
// own identity worth protecting from a duplicate-create the way a station
// or event row is - the same "PUT is idempotent" contract routes/favorites.ts
// exposes at the HTTP layer.
export async function addFavoriteStation(userId: number, stationId: number): Promise<void> {
  try {
    await query(
      `INSERT INTO user_favorite_stations (user_id, station_id) VALUES ($1, $2)
       ON CONFLICT (user_id, station_id) DO NOTHING`,
      [userId, stationId],
    );
  } catch (err) {
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new FavoriteStationNotFoundError(stationId);
    }
    throw err;
  }
}

// Equally idempotent in the other direction: un-favoriting a station that
// isn't currently favorited (or was never favorited at all) is still a
// clean success - there's no meaningful "404, that wasn't favorited"
// distinction worth making at this endpoint, the same "no needless extra
// steps" standard the Project Standard's UX requirement already holds
// security-sensitive flows to, applied here to a low-stakes preference
// toggle.
export async function removeFavoriteStation(userId: number, stationId: number): Promise<void> {
  await query("DELETE FROM user_favorite_stations WHERE user_id = $1 AND station_id = $2", [
    userId,
    stationId,
  ]);
}

export interface FavoriteStation {
  station: Station;
  favoritedAt: string;
}

export interface FavoriteStationListResult {
  favorites: FavoriteStation[];
  total: number;
}

export async function listFavoriteStations(
  userId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<FavoriteStationListResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_FAVORITE_LIST_LIMIT, 1), MAX_FAVORITE_LIST_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  // Filtered to currently-public (is_active) stations at the SQL level,
  // not in application code after the fact - so pagination.total and the
  // page actually returned always agree with each other. A station
  // favorited before being curated off (Step 17) keeps its favorite row
  // (soft state, never silently deleted out from under the user) but
  // simply doesn't appear here until it's reactivated - the same "the
  // public API never leaks curation state" rule GET /v1/stations already
  // enforces, now applied to a personal list too.
  const result = await query<{ station_id: number; favorited_at: string; total_count: string }>(
    `SELECT uf.station_id, uf.created_at AS favorited_at, COUNT(*) OVER() AS total_count
     FROM user_favorite_stations uf
     JOIN radio_stations s ON s.id = uf.station_id
     WHERE uf.user_id = $1 AND s.is_active = true
     ORDER BY uf.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  if (result.rows.length === 0) return { favorites: [], total: 0 };

  // Bulk-hydrated in one round trip, then re-sorted back into the
  // most-recently-favorited-first order the id query already determined -
  // Postgres's ANY($1) makes no ordering guarantee, the identical caveat
  // and fix as stationRankingRepository.getRankedStationsForCountry.
  const stations = await findStationsByIds(result.rows.map((row) => row.station_id));
  const stationsById = new Map(stations.map((station) => [station.id, station]));

  const favorites: FavoriteStation[] = [];
  for (const row of result.rows) {
    const station = stationsById.get(row.station_id);
    // Only a theoretical race (deactivated/deleted between the two queries
    // above) - skipped rather than thrown, the same race-tolerant
    // reasoning as getRankedStationsForCountry's own hydration step.
    if (station) {
      favorites.push({ station, favoritedAt: row.favorited_at });
    }
  }
  return { favorites, total: Number(result.rows[0].total_count) };
}

// Step 54: the reverse of listFavoriteStations - given a station, every
// user who currently has it favorited. Backs the favorite-station-
// availability push notification fan-out
// (favoriteStationAvailabilityNotifier.ts): unlike listFavoriteStations,
// this deliberately doesn't filter by the station's own is_active (the
// whole point is finding out who to notify *when* that value changes,
// including the exact call where it just flipped to false).
export async function listStationFavoriterUserIds(stationId: number): Promise<number[]> {
  const result = await query<{ user_id: number }>(
    "SELECT user_id FROM user_favorite_stations WHERE station_id = $1",
    [stationId],
  );
  return result.rows.map((row) => row.user_id);
}

export async function addFavoriteEvent(userId: number, eventId: number): Promise<void> {
  try {
    await query(
      `INSERT INTO user_favorite_events (user_id, event_id) VALUES ($1, $2)
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [userId, eventId],
    );
  } catch (err) {
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new FavoriteEventNotFoundError(eventId);
    }
    throw err;
  }
}

export async function removeFavoriteEvent(userId: number, eventId: number): Promise<void> {
  await query("DELETE FROM user_favorite_events WHERE user_id = $1 AND event_id = $2", [userId, eventId]);
}

export interface FavoriteEvent {
  event: Event;
  favoritedAt: string;
}

export interface FavoriteEventListResult {
  favorites: FavoriteEvent[];
  total: number;
}

export async function listFavoriteEvents(
  userId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<FavoriteEventListResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_FAVORITE_LIST_LIMIT, 1), MAX_FAVORITE_LIST_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  // Filtered to currently-'approved' events at the SQL level - the same
  // reasoning as listFavoriteStations' is_active filter, applied to
  // events' own moderation-state concept instead. An event favorited while
  // approved and later rejected (or one somehow favorited by an id lookup
  // before moderation, which the route's own pre-check already prevents)
  // keeps its favorite row but doesn't surface here while hidden.
  const result = await query<{ event_id: number; favorited_at: string; total_count: string }>(
    `SELECT uf.event_id, uf.created_at AS favorited_at, COUNT(*) OVER() AS total_count
     FROM user_favorite_events uf
     JOIN events e ON e.id = uf.event_id
     WHERE uf.user_id = $1 AND e.status = 'approved'
     ORDER BY uf.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  if (result.rows.length === 0) return { favorites: [], total: 0 };

  const events = await findEventsByIds(result.rows.map((row) => row.event_id));
  const eventsById = new Map(events.map((event) => [event.id, event]));

  const favorites: FavoriteEvent[] = [];
  for (const row of result.rows) {
    const event = eventsById.get(row.event_id);
    if (event) {
      favorites.push({ event, favoritedAt: row.favorited_at });
    }
  }
  return { favorites, total: Number(result.rows[0].total_count) };
}
