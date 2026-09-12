import type { PoolClient } from "pg";
import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";
import { normalizeStreamUrl } from "../utils/streamUrlValidation.js";
import type { Genre } from "./genresRepository.js";
import type { Language } from "./languagesRepository.js";

export interface Station {
  id: number;
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl: string | null;
  // Step 18: optional station artwork - the metadata source for the
  // client's image handling (proper codecs/formats, responsive sizing).
  logoUrl: string | null;
  description: string | null;
  isActive: boolean;
  // Step 17: only ever populated as a side effect of updateStation setting
  // isActive: false, and cleared again on reactivation - never
  // independently settable. Always null for a station this API's public
  // routes can return (they only ever show isActive: true stations), so
  // exposing these here carries no curation-state leak on that side.
  deactivatedAt: string | null;
  deactivatedByUserId: number | null;
  deactivationReason: string | null;
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
  logo_url: string | null;
  description: string | null;
  is_active: boolean;
  deactivated_at: string | null;
  deactivated_by_user_id: number | null;
  deactivation_reason: string | null;
  genres: Genre[] | null;
  languages: Language[] | null;
  created_at: string;
  updated_at: string;
  total_count: string;
}

export class DuplicateStreamUrlError extends Error {
  constructor(streamUrl: string) {
    super(`A station with this stream URL is already registered: ${streamUrl}`);
    this.name = "DuplicateStreamUrlError";
  }
}

// Step 16: a *different* stream_url string that normalizes (see
// normalizeStreamUrl) to the same value as an existing station's - never
// raised for the exact string collision above, which DuplicateStreamUrlError
// already covers; this is specifically the "looks different, is the same
// stream" case a byte-for-byte comparison can't catch.
export class NearDuplicateStreamUrlError extends Error {
  constructor(streamUrl: string) {
    super(
      "A station with an equivalent stream URL is already registered " +
        `(same host and path, ignoring letter case and an incidental trailing slash): ${streamUrl}`,
    );
    this.name = "NearDuplicateStreamUrlError";
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
const STREAM_URL_NORMALIZED_CONSTRAINT = "radio_stations_stream_url_normalized_key";

// Two independent correlated subqueries, not a single query joining both
// junction tables directly - a station with (say) 2 genres and 3 languages
// joined together in one query would fan out into 6 duplicated rows before
// any aggregation could run. json_agg inside each subquery keeps every
// station to exactly one row while still fetching everything in a single
// round trip. COALESCE(..., '[]') turns "no rows matched" into an empty
// array rather than a SQL NULL, so callers never need a null check.
//
// COUNT(*) OVER() adds the filtered-but-unpaginated total to every row in
// one pass - the alternative (a second COUNT(*) query with the same WHERE
// clause) would be two round trips and two chances for the filter logic to
// drift apart between them. Harmless overhead on the single-row lookups
// that also use this base query (findStationById) - just an unused column.
const STATION_SELECT = `
  SELECT
    s.id, s.country_id, s.name, s.stream_url, s.website_url, s.logo_url, s.description,
    s.is_active, s.deactivated_at, s.deactivated_by_user_id, s.deactivation_reason,
    s.created_at, s.updated_at,
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
    ) AS languages,
    COUNT(*) OVER() AS total_count
  FROM radio_stations s
`;

// Postgres's default LIKE/ILIKE escape character is already backslash, so
// escaping a caller's raw search text this way (before it's wrapped in %...%
// and bound as a single parameter - never concatenated into the query
// string) stops a search for a literal "%" or "_" from being misread as a
// wildcard. Not a SQL-injection concern either way (this is a bound
// parameter, not interpolated SQL) - purely about search results actually
// matching what the user typed.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toStation(row: StationRow): Station {
  return {
    id: row.id,
    countryId: row.country_id,
    name: row.name,
    streamUrl: row.stream_url,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    description: row.description,
    isActive: row.is_active,
    deactivatedAt: row.deactivated_at,
    deactivatedByUserId: row.deactivated_by_user_id,
    deactivationReason: row.deactivation_reason,
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
  logoUrl?: string | null;
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
        `INSERT INTO radio_stations
           (country_id, name, stream_url, stream_url_normalized, website_url, logo_url, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.countryId,
          input.name,
          input.streamUrl,
          normalizeStreamUrl(input.streamUrl),
          input.websiteUrl ?? null,
          input.logoUrl ?? null,
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

export const DEFAULT_STATION_LIST_LIMIT = 50;
export const MAX_STATION_LIST_LIMIT = 100;

export interface StationListFilter {
  countryId?: number;
  genreId?: number;
  languageId?: number;
  // Case-insensitive substring match against the station name. Plain
  // ILIKE, not a full-text index - appropriate for a curated catalog on
  // the order of dozens to a few hundred stations, not the kind of corpus
  // that would justify tsvector's added complexity.
  search?: string;
  // Tri-state, not a plain boolean default: undefined means no filter at
  // all (every station regardless of curation state - what the admin
  // listing needs to show everything), true/false filters to exactly
  // that state. The public route (src/routes/stations.ts) always passes
  // true explicitly and never lets a client override it; the admin route
  // exposes this as a real, client-controlled filter.
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface StationListResult {
  stations: Station[];
  total: number;
}

export async function listStations(filter: StationListFilter = {}): Promise<StationListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.countryId !== undefined) {
    values.push(filter.countryId);
    conditions.push(`s.country_id = $${values.length}`);
  }
  if (filter.isActive !== undefined) {
    values.push(filter.isActive);
    conditions.push(`s.is_active = $${values.length}`);
  }
  if (filter.genreId !== undefined) {
    values.push(filter.genreId);
    conditions.push(
      `EXISTS (SELECT 1 FROM station_genres sg WHERE sg.station_id = s.id AND sg.genre_id = $${values.length})`,
    );
  }
  if (filter.languageId !== undefined) {
    values.push(filter.languageId);
    conditions.push(
      `EXISTS (SELECT 1 FROM station_languages sl WHERE sl.station_id = s.id AND sl.language_id = $${values.length})`,
    );
  }
  if (filter.search !== undefined && filter.search.trim() !== "") {
    values.push(`%${escapeLikePattern(filter.search.trim())}%`);
    conditions.push(`s.name ILIKE $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Capped here too, not just in the route's JSON Schema (maximum: 100) -
  // this repository function is public and a future internal caller
  // (an admin tool, a background job) that forgets to apply that same
  // schema shouldn't be able to trigger an unbounded scan by omitting a
  // limit or passing an enormous one.
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_STATION_LIST_LIMIT, 1), MAX_STATION_LIST_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);
  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  const result = await query<StationRow>(
    `${STATION_SELECT} ${where} ORDER BY s.name ASC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values,
  );
  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  return { stations: result.rows.map(toStation), total };
}

export async function findStationById(id: number): Promise<Station | null> {
  const result = await query<StationRow>(`${STATION_SELECT} WHERE s.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toStation(row) : null;
}

// Step 22: bulk-hydrates full Station objects (genres/languages included)
// for a set of ids in one round trip - the ranking repository already
// knows *which* stations and in *what order* from its own reliability
// query, so re-fetching them one at a time via findStationById would be an
// avoidable N+1. Postgres's ANY($1) makes no ordering guarantee, so the
// caller is responsible for re-sorting these back into its own ranked
// order - this function only ever hydrates, it never ranks.
export async function findStationsByIds(ids: number[]): Promise<Station[]> {
  if (ids.length === 0) return [];
  const result = await query<StationRow>(`${STATION_SELECT} WHERE s.id = ANY($1)`, [ids]);
  return result.rows.map(toStation);
}

export interface StationHealthCheckTarget {
  id: number;
  streamUrl: string;
}

// Step 20: the background health-check worker's own listing query -
// deliberately not listStations()/STATION_SELECT. A sweep across the whole
// catalog only ever needs a station's id and streamUrl, never its
// genres/languages (the two json_agg subqueries) or the pagination
// COUNT(*) OVER() - fetching those for every row on every sweep tick would
// be pure overhead for a query that could run frequently and touch the
// entire catalog. Only active stations: a deactivated one doesn't need
// automatic monitoring (an admin can still check it manually via
// POST /v1/admin/stations/:id/health-check, which never filters on
// isActive).
export async function listActiveStationsForHealthCheck(): Promise<StationHealthCheckTarget[]> {
  const result = await query<{ id: number; stream_url: string }>(
    "SELECT id, stream_url FROM radio_stations WHERE is_active = true",
  );
  return result.rows.map((row) => ({ id: row.id, streamUrl: row.stream_url }));
}

export interface StationUpdate {
  countryId?: number;
  name?: string;
  streamUrl?: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  isActive?: boolean;
  // Step 17: only meaningful together with isActive: false in the same
  // update - the route validates that combination before this function is
  // ever called. Never independently editable, and never carried forward:
  // reactivating (isActive: true) always clears it along with
  // deactivatedAt/deactivatedByUserId, regardless of whether this field is
  // present on that same request.
  deactivationReason?: string;
  // undefined = leave associations untouched; [] = clear them; a
  // non-empty array = replace them with exactly this set - the same
  // "undefined means don't touch this field" convention as every other
  // field here, just applied to a set instead of a scalar.
  genreIds?: number[];
  languageIds?: number[];
}

// actorUserId: the admin performing this write - recorded as
// deactivated_by_user_id only when this call is the one that flips
// isActive to false. Required unconditionally (not just when deactivating)
// so every call site provides it consistently, the same reasoning
// createStation already applies to createdByUserId.
export async function updateStation(
  id: number,
  updates: StationUpdate,
  actorUserId: number,
): Promise<Station | null> {
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
    values.push(normalizeStreamUrl(updates.streamUrl));
    setClauses.push(`stream_url_normalized = $${values.length}`);
  }
  if (updates.websiteUrl !== undefined) {
    values.push(updates.websiteUrl);
    setClauses.push(`website_url = $${values.length}`);
  }
  if (updates.logoUrl !== undefined) {
    values.push(updates.logoUrl);
    setClauses.push(`logo_url = $${values.length}`);
  }
  if (updates.description !== undefined) {
    values.push(updates.description);
    setClauses.push(`description = $${values.length}`);
  }
  if (updates.isActive !== undefined) {
    values.push(updates.isActive);
    setClauses.push(`is_active = $${values.length}`);
    if (updates.isActive === false) {
      setClauses.push("deactivated_at = now()");
      values.push(actorUserId);
      setClauses.push(`deactivated_by_user_id = $${values.length}`);
      values.push(updates.deactivationReason ?? null);
      setClauses.push(`deactivation_reason = $${values.length}`);
    } else {
      // Reactivating clears any prior deactivation record - a reason for
      // being inactive stops applying once the station is active again.
      setClauses.push(
        "deactivated_at = NULL",
        "deactivated_by_user_id = NULL",
        "deactivation_reason = NULL",
      );
    }
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
    if (pgConstraintName(err) === STREAM_URL_NORMALIZED_CONSTRAINT) {
      return new NearDuplicateStreamUrlError(streamUrl);
    }
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
