import type { PoolClient } from "pg";
import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";
import type { Genre } from "./genresRepository.js";
import type { Language } from "./languagesRepository.js";

export interface Station {
  id: number;
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl: string | null;
  description: string | null;
  isActive: boolean;
  genres: Genre[];
  languages: Language[];
  createdAt: string;
  updatedAt: string;
}

interface StationRow {
  id: number;
  country_id: number;
  name: string;
  stream_url: string;
  website_url: string | null;
  description: string | null;
  is_active: boolean;
  genres: Genre[] | null;
  languages: Language[] | null;
  created_at: string;
  updated_at: string;
}

export class DuplicateStreamUrlError extends Error {
  constructor(streamUrl: string) {
    super(`A station with this stream URL is already registered: ${streamUrl}`);
    this.name = "DuplicateStreamUrlError";
  }
}

export class InvalidCountryError extends Error {
  constructor(countryId: number) {
    super(`No country with id ${countryId}`);
    this.name = "InvalidCountryError";
  }
}

export class InvalidGenreError extends Error {
  constructor() {
    super("One or more genreIds do not match a known genre");
    this.name = "InvalidGenreError";
  }
}

export class InvalidLanguageError extends Error {
  constructor() {
    super("One or more languageIds do not match a known language");
    this.name = "InvalidLanguageError";
  }
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// Two independent correlated subqueries, not a single query joining both
// junction tables directly - a station with (say) 2 genres and 3 languages
// joined together in one query would fan out into 6 duplicated rows before
// any aggregation could run. json_agg inside each subquery keeps every
// station to exactly one row while still fetching everything in a single
// round trip. COALESCE(..., '[]') turns "no rows matched" into an empty
// array rather than a SQL NULL, so callers never need a null check.
const STATION_SELECT = `
  SELECT
    s.id, s.country_id, s.name, s.stream_url, s.website_url, s.description,
    s.is_active, s.created_at, s.updated_at,
    COALESCE(
      (SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
       FROM station_genres sg JOIN genres g ON g.id = sg.genre_id
       WHERE sg.station_id = s.id),
      '[]'
    ) AS genres,
    COALESCE(
      (SELECT json_agg(json_build_object('id', l.id, 'code', l.code, 'name', l.name) ORDER BY l.name)
       FROM station_languages sl JOIN languages l ON l.id = sl.language_id
       WHERE sl.station_id = s.id),
      '[]'
    ) AS languages
  FROM radio_stations s
`;

function toStation(row: StationRow): Station {
  return {
    id: row.id,
    countryId: row.country_id,
    name: row.name,
    streamUrl: row.stream_url,
    websiteUrl: row.website_url,
    description: row.description,
    isActive: row.is_active,
    genres: row.genres ?? [],
    languages: row.languages ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Replaces a station's full set of genre/language associations (DELETE
// then bulk INSERT) rather than diffing - simpler and just as correct for
// the write volume an admin-curated catalog actually sees, and it makes
// "what genres does this station have now" always exactly what the caller
// just sent, no partial-application edge cases. ON CONFLICT DO NOTHING
// tolerates a duplicate id appearing twice in the caller's own array
// instead of failing the whole write over it. A pg client, not the pool
// directly, so this always runs inside the same transaction as the
// station row it belongs to.
async function replaceStationGenres(
  client: PoolClient,
  stationId: number,
  genreIds: number[],
): Promise<void> {
  await client.query("DELETE FROM station_genres WHERE station_id = $1", [stationId]);
  const uniqueIds = [...new Set(genreIds)];
  if (uniqueIds.length === 0) return;
  const values = uniqueIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO station_genres (station_id, genre_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [stationId, ...uniqueIds],
  );
}

async function replaceStationLanguages(
  client: PoolClient,
  stationId: number,
  languageIds: number[],
): Promise<void> {
  await client.query("DELETE FROM station_languages WHERE station_id = $1", [stationId]);
  const uniqueIds = [...new Set(languageIds)];
  if (uniqueIds.length === 0) return;
  const values = uniqueIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO station_languages (station_id, language_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [stationId, ...uniqueIds],
  );
}

export interface NewStation {
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl?: string | null;
  description?: string | null;
  genreIds?: number[];
  languageIds?: number[];
  createdByUserId?: number | null;
}

export async function createStation(input: NewStation): Promise<Station> {
  let newId: number;
  try {
    newId = await withTransaction(async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO radio_stations (country_id, name, stream_url, website_url, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.countryId,
          input.name,
          input.streamUrl,
          input.websiteUrl ?? null,
          input.description ?? null,
          input.createdByUserId ?? null,
        ],
      );
      const id = result.rows[0].id;
      if (input.genreIds) {
        await replaceStationGenres(client, id, input.genreIds);
      }
      if (input.languageIds) {
        await replaceStationLanguages(client, id, input.languageIds);
      }
      return id;
    });
  } catch (err) {
    throw toStationWriteError(err, input.streamUrl, input.countryId);
  }

  // Re-fetched rather than assembled from the input in memory - the
  // canonical, fully-hydrated (genres/languages included) row this
  // transaction actually committed, not a reconstruction that could drift
  // from it.
  const station = await findStationById(newId);
  if (!station) {
    throw new Error(`Station ${newId} vanished immediately after being created`);
  }
  return station;
}

export interface StationListFilter {
  countryId?: number;
  // Defaults to true (the public catalog never surfaces a curated-off
  // station); an admin-facing caller passes false explicitly to see
  // everything, e.g. while deciding what to re-activate.
  activeOnly?: boolean;
}

export async function listStations(filter: StationListFilter = {}): Promise<Station[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.countryId !== undefined) {
    values.push(filter.countryId);
    conditions.push(`s.country_id = $${values.length}`);
  }
  if (filter.activeOnly !== false) {
    conditions.push("s.is_active = true");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query<StationRow>(`${STATION_SELECT} ${where} ORDER BY s.name ASC`, values);
  return result.rows.map(toStation);
}

export async function findStationById(id: number): Promise<Station | null> {
  const result = await query<StationRow>(`${STATION_SELECT} WHERE s.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toStation(row) : null;
}

export interface StationUpdate {
  countryId?: number;
  name?: string;
  streamUrl?: string;
  websiteUrl?: string | null;
  description?: string | null;
  isActive?: boolean;
  // undefined = leave associations untouched; [] = clear them; a
  // non-empty array = replace them with exactly this set - the same
  // "undefined means don't touch this field" convention as every other
  // field here, just applied to a set instead of a scalar.
  genreIds?: number[];
  languageIds?: number[];
}

export async function updateStation(id: number, updates: StationUpdate): Promise<Station | null> {
  // Built from only the fields actually present, so a partial update never
  // overwrites a column the caller didn't intend to touch - the same
  // pattern as usersRepository.updateUserProfile.
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.countryId !== undefined) {
    values.push(updates.countryId);
    setClauses.push(`country_id = $${values.length}`);
  }
  if (updates.name !== undefined) {
    values.push(updates.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (updates.streamUrl !== undefined) {
    values.push(updates.streamUrl);
    setClauses.push(`stream_url = $${values.length}`);
  }
  if (updates.websiteUrl !== undefined) {
    values.push(updates.websiteUrl);
    setClauses.push(`website_url = $${values.length}`);
  }
  if (updates.description !== undefined) {
    values.push(updates.description);
    setClauses.push(`description = $${values.length}`);
  }
  if (updates.isActive !== undefined) {
    values.push(updates.isActive);
    setClauses.push(`is_active = $${values.length}`);
  }

  const touchesTags = updates.genreIds !== undefined || updates.languageIds !== undefined;
  if (setClauses.length === 0 && !touchesTags) {
    return findStationById(id);
  }

  try {
    await withTransaction(async (client) => {
      // Always runs - even a tags-only update bumps updated_at, and the
      // UPDATE's rowCount is also how a nonexistent station id gets
      // detected (a tags-only write against a missing id would otherwise
      // silently no-op instead of surfacing as "not found").
      setClauses.push("updated_at = now()");
      const result = await client.query(
        `UPDATE radio_stations SET ${setClauses.join(", ")} WHERE id = $${values.length + 1}`,
        [...values, id],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new StationNotFoundSentinel();
      }
      if (updates.genreIds !== undefined) {
        await replaceStationGenres(client, id, updates.genreIds);
      }
      if (updates.languageIds !== undefined) {
        await replaceStationLanguages(client, id, updates.languageIds);
      }
    });
  } catch (err) {
    if (err instanceof StationNotFoundSentinel) {
      return null;
    }
    throw toStationWriteError(err, updates.streamUrl, updates.countryId);
  }

  return findStationById(id);
}

// Internal-only signal from inside the transaction ("the UPDATE matched
// zero rows") back out to updateStation's null-return contract - never
// escapes this module, so it's deliberately not exported alongside the
// other error classes above.
class StationNotFoundSentinel extends Error {}

function toStationWriteError(err: unknown, streamUrl?: string, countryId?: number): unknown {
  if (hasPgErrorCode(err, UNIQUE_VIOLATION) && streamUrl !== undefined) {
    return new DuplicateStreamUrlError(streamUrl);
  }
  if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
    const constraint = pgConstraintName(err);
    if (constraint?.includes("genre")) return new InvalidGenreError();
    if (constraint?.includes("language")) return new InvalidLanguageError();
    if (countryId !== undefined) return new InvalidCountryError(countryId);
  }
  return err;
}

export async function deleteStation(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query("DELETE FROM radio_stations WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function pgConstraintName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "constraint" in err) {
    const constraint = (err as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : undefined;
  }
  return undefined;
}
