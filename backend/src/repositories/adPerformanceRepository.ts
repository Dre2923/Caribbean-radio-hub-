// Step 62 (Background Update Workers, part two): the Advertising
// performance rollup. See migration 1700000027000_ad_performance_daily's
// own comment for why this table exists alongside, not instead of, Step
// 57's real-time getAdPlacementReport, and why it stores only
// (placement, date) combinations that actually had at least one event.

import { query } from "../db/pool.js";

export interface AdPerformanceDailyRow {
  placementId: number;
  placementKey: string;
  date: string;
  impressions: number;
  clicks: number;
  updatedAt: string;
}

// Computes real impression/click counts straight from ad_events for a
// single UTC calendar day, grouped by placement - the rollup worker's own
// source-of-truth read, kept separate from the upsert write below so it
// stays independently testable (given a date, what would today's rollup
// actually compute) without needing to also perform the write.
//
// date is a plain 'YYYY-MM-DD' string, always interpreted as a UTC
// calendar day (created_at >= date AND created_at < date + 1 day) - the
// same unambiguous-boundary reasoning as every other date-range filter in
// this codebase (e.g. getAdPlacementReport's own startsAfter/startsBefore
// are passed straight through as ISO timestamps by their caller); the
// worker itself is what decides which day to roll up.
export async function computeAdEventCountsForDate(
  date: string,
): Promise<{ placementId: number; impressions: number; clicks: number }[]> {
  const result = await query<{ placement_id: number; impressions: string; clicks: string }>(
    `SELECT
       placement_id,
       COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
       COUNT(*) FILTER (WHERE event_type = 'click') AS clicks
     FROM ad_events
     WHERE created_at >= $1::date AND created_at < $1::date + INTERVAL '1 day'
     GROUP BY placement_id`,
    [date],
  );
  return result.rows.map((row) => ({
    placementId: row.placement_id,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
  }));
}

// Idempotent upsert - a redundant re-run of the same day's rollup (the
// worker's own tick interval overlapping a slow previous run, or a process
// restart mid-day) overwrites with freshly recomputed counts rather than
// erroring or double-counting, the identical ON CONFLICT ... DO UPDATE
// shape already used throughout this codebase (registerPushToken,
// updateNotificationPreferences).
export async function upsertAdPerformanceDaily(
  placementId: number,
  date: string,
  impressions: number,
  clicks: number,
): Promise<void> {
  await query(
    `INSERT INTO ad_performance_daily (placement_id, date, impressions, clicks, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (placement_id, date) DO UPDATE
       SET impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           updated_at = now()`,
    [placementId, date, impressions, clicks],
  );
}

export interface AdPerformanceDailyFilter {
  placementId?: number;
  startDate?: string;
  endDate?: string;
}

// The admin listing endpoint's own read (GET /v1/admin/ads/performance-
// daily). Joins ad_placements for placementKey (the same "an id alone
// isn't a useful label in a report" reasoning getAdPlacementReport's own
// row shape already applies) - an INNER join, not LEFT, is correct here
// unlike that report's own LEFT JOIN: a row in ad_performance_daily only
// ever exists for a placement that still exists (placement_id CASCADEs on
// the placement's own deletion), so there's no "placement with zero rows"
// case for this table to preserve the way that report's zero-count rows
// need to be.
export async function listAdPerformanceDaily(
  filter: AdPerformanceDailyFilter = {},
): Promise<AdPerformanceDailyRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.placementId !== undefined) {
    values.push(filter.placementId);
    conditions.push(`d.placement_id = $${values.length}`);
  }
  if (filter.startDate !== undefined) {
    values.push(filter.startDate);
    conditions.push(`d.date >= $${values.length}`);
  }
  if (filter.endDate !== undefined) {
    values.push(filter.endDate);
    conditions.push(`d.date <= $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query<{
    placement_id: number;
    placement_key: string;
    date: string;
    impressions: number;
    clicks: number;
    updated_at: string;
  }>(
    // d.date::text, not the bare date column - node-postgres's default type
    // parser for a DATE column returns a JS Date object, not a string; this
    // repository's own AdPerformanceDailyRow contract promises a plain
    // 'YYYY-MM-DD' string, so the cast happens here rather than relying on
    // Fastify's response serializer to paper over the mismatch downstream.
    `SELECT d.placement_id, p.placement_key, d.date::text AS date, d.impressions, d.clicks, d.updated_at
     FROM ad_performance_daily d
     JOIN ad_placements p ON p.id = d.placement_id
     ${where}
     ORDER BY d.date DESC, p.placement_key ASC`,
    values,
  );

  return result.rows.map((row) => ({
    placementId: row.placement_id,
    placementKey: row.placement_key,
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    updatedAt: row.updated_at,
  }));
}
