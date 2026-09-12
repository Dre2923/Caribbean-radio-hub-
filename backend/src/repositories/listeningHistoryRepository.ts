// User Features (Step 52): listening history. Unlike Step 51's favorites,
// this is a purely client-reported historical log, not something the
// backend can observe on its own - see migration
// 1700000020000_listening_history's own comment for why (no server-side
// "now playing" state exists anywhere in this system).

import { query } from "../db/pool.js";
import { findStationsByIds, type Station } from "./stationsRepository.js";

export const DEFAULT_HISTORY_LIST_LIMIT = 50;
export const MAX_HISTORY_LIST_LIMIT = 100;

const FOREIGN_KEY_VIOLATION = "23503";

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export class InvalidStationError extends Error {
  constructor(stationId: number) {
    super(`No station with id ${stationId}`);
    this.name = "InvalidStationError";
  }
}

export interface ListeningHistoryEntry {
  id: number;
  // null only once the station this entry pointed to has since been
  // hard-deleted (ON DELETE SET NULL, see the migration comment) - the
  // record that a listen happened, and when, is preserved either way.
  // Deliberately not filtered by the station's current isActive the way
  // Step 51's favorites list is: this is a historical record ("you
  // listened to this at 3pm yesterday"), not an actionable "go listen to
  // this" list, so it shows the station regardless of its current
  // curation state - a real, deliberate difference from favorites, not
  // an inconsistency.
  station: Station | null;
  listenedAt: string;
}

// The acting user reported this listen just now - no client-supplied
// timestamp is accepted (recordListen takes no listenedAt parameter at
// all). The same "the database's own now(), not an app-server or
// client-supplied Date" posture already applied to moderated_at/
// deactivated_at elsewhere: a client's device clock is never trusted for
// an authoritative record.
export async function recordListen(userId: number, stationId: number): Promise<ListeningHistoryEntry> {
  let row: { id: number; listened_at: string };
  try {
    const result = await query<{ id: number; listened_at: string }>(
      `INSERT INTO listening_history (user_id, station_id) VALUES ($1, $2)
       RETURNING id, listened_at`,
      [userId, stationId],
    );
    row = result.rows[0];
  } catch (err) {
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new InvalidStationError(stationId);
    }
    throw err;
  }

  const stations = await findStationsByIds([stationId]);
  return { id: row.id, station: stations[0] ?? null, listenedAt: row.listened_at };
}

export interface ListeningHistoryListResult {
  entries: ListeningHistoryEntry[];
  total: number;
}

export async function listListeningHistory(
  userId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<ListeningHistoryListResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_LIST_LIMIT, 1), MAX_HISTORY_LIST_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await query<{
    id: number;
    station_id: number | null;
    listened_at: string;
    total_count: string;
  }>(
    `SELECT id, station_id, listened_at, COUNT(*) OVER() AS total_count
     FROM listening_history
     WHERE user_id = $1
     ORDER BY listened_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  if (result.rows.length === 0) return { entries: [], total: 0 };

  // Bulk-hydrated in one round trip, then re-matched back onto each row -
  // the identical pattern as favoritesRepository.listFavoriteStations,
  // just tolerating a null station_id (a hard-deleted station, see the
  // ListeningHistoryEntry.station comment above) as a valid, expected
  // case rather than only a theoretical race.
  const stationIds = [...new Set(result.rows.map((row) => row.station_id).filter((id): id is number => id !== null))];
  const stations = await findStationsByIds(stationIds);
  const stationsById = new Map(stations.map((station) => [station.id, station]));

  const entries: ListeningHistoryEntry[] = result.rows.map((row) => ({
    id: row.id,
    station: row.station_id !== null ? (stationsById.get(row.station_id) ?? null) : null,
    listenedAt: row.listened_at,
  }));
  return { entries, total: Number(result.rows[0].total_count) };
}

export async function clearListeningHistory(userId: number): Promise<void> {
  await query("DELETE FROM listening_history WHERE user_id = $1", [userId]);
}
