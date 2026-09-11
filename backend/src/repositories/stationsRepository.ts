import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

export interface Station {
  id: number;
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl: string | null;
  description: string | null;
  isActive: boolean;
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

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const STATION_COLUMNS =
  "id, country_id, name, stream_url, website_url, description, is_active, created_at, updated_at";

function toStation(row: StationRow): Station {
  return {
    id: row.id,
    countryId: row.country_id,
    name: row.name,
    streamUrl: row.stream_url,
    websiteUrl: row.website_url,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewStation {
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl?: string | null;
  description?: string | null;
  createdByUserId?: number | null;
}

export async function createStation(input: NewStation): Promise<Station> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<StationRow>(
        `INSERT INTO radio_stations (country_id, name, stream_url, website_url, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${STATION_COLUMNS}`,
        [
          input.countryId,
          input.name,
          input.streamUrl,
          input.websiteUrl ?? null,
          input.description ?? null,
          input.createdByUserId ?? null,
        ],
      );
      return toStation(result.rows[0]);
    });
  } catch (err) {
    if (hasPgErrorCode(err, UNIQUE_VIOLATION)) {
      throw new DuplicateStreamUrlError(input.streamUrl);
    }
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new InvalidCountryError(input.countryId);
    }
    throw err;
  }
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
    conditions.push(`country_id = $${values.length}`);
  }
  if (filter.activeOnly !== false) {
    conditions.push("is_active = true");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query<StationRow>(
    `SELECT ${STATION_COLUMNS} FROM radio_stations ${where} ORDER BY name ASC`,
    values,
  );
  return result.rows.map(toStation);
}

export async function findStationById(id: number): Promise<Station | null> {
  const result = await query<StationRow>(
    `SELECT ${STATION_COLUMNS} FROM radio_stations WHERE id = $1`,
    [id],
  );
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

  if (setClauses.length === 0) {
    return findStationById(id);
  }

  setClauses.push("updated_at = now()");
  values.push(id);

  try {
    return await withTransaction(async (client) => {
      const result = await client.query<StationRow>(
        `UPDATE radio_stations SET ${setClauses.join(", ")}
         WHERE id = $${values.length}
         RETURNING ${STATION_COLUMNS}`,
        values,
      );
      return result.rows[0] ? toStation(result.rows[0]) : null;
    });
  } catch (err) {
    if (hasPgErrorCode(err, UNIQUE_VIOLATION) && updates.streamUrl !== undefined) {
      throw new DuplicateStreamUrlError(updates.streamUrl);
    }
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION) && updates.countryId !== undefined) {
      throw new InvalidCountryError(updates.countryId);
    }
    throw err;
  }
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
