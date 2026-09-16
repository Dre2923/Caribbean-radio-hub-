// Step 56 (Advertising, part one): ad placement configuration. See
// migration 1700000023000_ad_placements's own comment for the full design
// reasoning (mediation-SDK scope, nullable country_id as
// global-default-vs-override, the two-constraint NULL-uniqueness fix, the
// active-requires-ad-unit-id invariant).

import { query } from "../db/pool.js";

export const AD_FORMATS = ["banner", "interstitial", "rewarded", "native"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export class InvalidCountryError extends Error {
  constructor(countryId: number) {
    super(`No country with id ${countryId}`);
    this.name = "InvalidCountryError";
  }
}

// Covers both real uniqueness rules at once (the plain per-country
// constraint and the global-row partial unique index) - Postgres reports
// the identical 23505 code either way, and a caller only ever needs to
// know "this placement_key already has a row for this scope", not which
// of the two indexes caught it.
export class DuplicateAdPlacementError extends Error {
  constructor(placementKey: string, countryId: number | null) {
    super(
      countryId === null
        ? `A global default placement already exists for "${placementKey}"`
        : `A placement already exists for "${placementKey}" in country ${countryId}`,
    );
    this.name = "DuplicateAdPlacementError";
  }
}

// The route layer validates this up front for a clean 400 - this class
// exists as defense-in-depth for the DB's own CHECK constraint, the same
// "validated at the application layer, backstopped at the database layer"
// posture Step 30's latitude/longitude columns already establish.
export class AdPlacementMissingAdUnitError extends Error {
  constructor() {
    super("An active placement needs at least one of androidAdUnitId/iosAdUnitId set");
    this.name = "AdPlacementMissingAdUnitError";
  }
}

export interface AdPlacement {
  id: number;
  placementKey: string;
  countryId: number | null;
  adFormat: AdFormat;
  androidAdUnitId: string | null;
  iosAdUnitId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AdPlacementRow {
  id: number;
  placement_key: string;
  country_id: number | null;
  ad_format: AdFormat;
  android_ad_unit_id: string | null;
  ios_ad_unit_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toAdPlacement(row: AdPlacementRow): AdPlacement {
  return {
    id: row.id,
    placementKey: row.placement_key,
    countryId: row.country_id,
    adFormat: row.ad_format,
    androidAdUnitId: row.android_ad_unit_id,
    iosAdUnitId: row.ios_ad_unit_id,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAdPlacementInput {
  placementKey: string;
  countryId: number | null;
  adFormat: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
}

function handleWriteError(
  err: unknown,
  placementKey: string,
  countryId: number | null,
): never {
  if (hasPgErrorCode(err, UNIQUE_VIOLATION)) {
    throw new DuplicateAdPlacementError(placementKey, countryId);
  }
  if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
    throw new InvalidCountryError(countryId as number);
  }
  if (hasPgErrorCode(err, CHECK_VIOLATION)) {
    throw new AdPlacementMissingAdUnitError();
  }
  throw err;
}

export async function createAdPlacement(input: CreateAdPlacementInput): Promise<AdPlacement> {
  try {
    const result = await query<AdPlacementRow>(
      `INSERT INTO ad_placements
         (placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id,
                 is_active, created_at, updated_at`,
      [
        input.placementKey,
        input.countryId,
        input.adFormat,
        input.androidAdUnitId ?? null,
        input.iosAdUnitId ?? null,
        input.isActive ?? false,
      ],
    );
    return toAdPlacement(result.rows[0]);
  } catch (err) {
    handleWriteError(err, input.placementKey, input.countryId);
  }
}

export interface UpdateAdPlacementInput {
  countryId?: number | null;
  adFormat?: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
}

export async function updateAdPlacement(
  id: number,
  input: UpdateAdPlacementInput,
): Promise<AdPlacement | null> {
  const existing = await getAdPlacementById(id);
  if (!existing) return null;

  const next = {
    countryId: input.countryId !== undefined ? input.countryId : existing.countryId,
    adFormat: input.adFormat ?? existing.adFormat,
    androidAdUnitId:
      input.androidAdUnitId !== undefined ? input.androidAdUnitId : existing.androidAdUnitId,
    iosAdUnitId: input.iosAdUnitId !== undefined ? input.iosAdUnitId : existing.iosAdUnitId,
    isActive: input.isActive ?? existing.isActive,
  };

  try {
    const result = await query<AdPlacementRow>(
      `UPDATE ad_placements
       SET country_id = $2, ad_format = $3, android_ad_unit_id = $4, ios_ad_unit_id = $5,
           is_active = $6, updated_at = now()
       WHERE id = $1
       RETURNING id, placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id,
                 is_active, created_at, updated_at`,
      [id, next.countryId, next.adFormat, next.androidAdUnitId, next.iosAdUnitId, next.isActive],
    );
    return result.rows[0] ? toAdPlacement(result.rows[0]) : null;
  } catch (err) {
    handleWriteError(err, existing.placementKey, next.countryId);
  }
}

export async function deleteAdPlacement(id: number): Promise<void> {
  await query("DELETE FROM ad_placements WHERE id = $1", [id]);
}

export async function getAdPlacementById(id: number): Promise<AdPlacement | null> {
  const result = await query<AdPlacementRow>(
    `SELECT id, placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id,
            is_active, created_at, updated_at
     FROM ad_placements WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toAdPlacement(result.rows[0]) : null;
}

export interface ListAdPlacementsOptions {
  countryId?: number;
  isActive?: boolean;
}

// Admin listing - every row regardless of scope, optionally filtered. Not
// the country-resolution query below, which is a different, public-facing
// shape entirely.
export async function listAdPlacements(
  options: ListAdPlacementsOptions = {},
): Promise<AdPlacement[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.countryId !== undefined) {
    params.push(options.countryId);
    conditions.push(`country_id = $${params.length}`);
  }
  if (options.isActive !== undefined) {
    params.push(options.isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query<AdPlacementRow>(
    `SELECT id, placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id,
            is_active, created_at, updated_at
     FROM ad_placements
     ${whereClause}
     ORDER BY placement_key ASC, country_id ASC NULLS FIRST`,
    params,
  );
  return result.rows.map(toAdPlacement);
}

// The real client-facing resolution query (GET /v1/ads/config): for every
// distinct placement_key with at least one active row visible to this
// country, return exactly one row - the country-specific override when one
// exists and is active, falling back to the global default (country_id
// NULL) otherwise. `DISTINCT ON (placement_key)` combined with
// `ORDER BY placement_key, country_id NULLS LAST` is what implements that
// preference: for each placement_key group, Postgres keeps only the first
// row in ORDER BY order, and a non-null country_id always sorts before a
// NULL one under NULLS LAST - so the country-specific row wins whenever
// both exist, verified directly with a placement that has both a global
// and a country-specific row registered.
export async function getActiveAdPlacementsForCountry(countryId: number): Promise<AdPlacement[]> {
  const result = await query<AdPlacementRow>(
    `SELECT DISTINCT ON (placement_key)
            id, placement_key, country_id, ad_format, android_ad_unit_id, ios_ad_unit_id,
            is_active, created_at, updated_at
     FROM ad_placements
     WHERE is_active = true AND (country_id = $1 OR country_id IS NULL)
     ORDER BY placement_key ASC, country_id ASC NULLS LAST`,
    [countryId],
  );
  return result.rows.map(toAdPlacement);
}
