// Step 57 (Advertising, part two): first-party placement-level reporting.
// See migration 1700000025000_ad_events's own comment for the full design
// reasoning (why no user_id, why country_id is SET NULL but placement_id
// is CASCADE).

import { query } from "../db/pool.js";

export const AD_EVENT_TYPES = ["impression", "click"] as const;
export type AdEventType = (typeof AD_EVENT_TYPES)[number];

const FOREIGN_KEY_VIOLATION = "23503";

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export class InvalidAdPlacementError extends Error {
  constructor(placementId: number) {
    super(`No ad placement with id ${placementId}`);
    this.name = "InvalidAdPlacementError";
  }
}

export interface RecordAdEventInput {
  placementId: number;
  eventType: AdEventType;
  countryId: number | null;
}

// Deliberately no return value beyond success/failure - this is a
// fire-and-forget analytics write from the client's perspective (it
// already showed the ad or registered the click via the mediation SDK
// before ever calling this), the same "this call is reporting something
// that already happened, not asking permission for it" shape as
// POST /v1/me/listening-history.
export async function recordAdEvent(input: RecordAdEventInput): Promise<void> {
  try {
    await query(
      "INSERT INTO ad_events (placement_id, event_type, country_id) VALUES ($1, $2, $3)",
      [input.placementId, input.eventType, input.countryId],
    );
  } catch (err) {
    if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
      throw new InvalidAdPlacementError(input.placementId);
    }
    throw err;
  }
}

export interface AdPlacementReportRow {
  placementId: number;
  placementKey: string;
  impressions: number;
  clicks: number;
}

export interface AdReportOptions {
  countryId?: number;
  startsAfter?: string;
  startsBefore?: string;
}

// One row per placement that currently exists, impressions/clicks both
// real zero (not null/omitted) when it has no matching events - an admin
// comparing performance across placements needs "this one got zero
// impressions in this window" as a visible data point, not a silently
// missing row, the same "zero is a real, distinct answer" reasoning
// already applied to getStationReliability's own null-vs-0 distinction
// (Step 21), just the other direction: here zero genuinely is correct
// (no events happened), whereas there null meant "no data to compute
// from" - counting real rows can never itself be ambiguous the way an
// average can.
export async function getAdPlacementReport(
  options: AdReportOptions = {},
): Promise<AdPlacementReportRow[]> {
  const eventConditions: string[] = [];
  const params: unknown[] = [];

  if (options.countryId !== undefined) {
    params.push(options.countryId);
    eventConditions.push(`e.country_id = $${params.length}`);
  }
  if (options.startsAfter !== undefined) {
    params.push(options.startsAfter);
    eventConditions.push(`e.created_at >= $${params.length}`);
  }
  if (options.startsBefore !== undefined) {
    params.push(options.startsBefore);
    eventConditions.push(`e.created_at < $${params.length}`);
  }

  // The event-level filters (country/date range) live inside the LEFT
  // JOIN's own ON clause, not a WHERE clause on the joined result - a
  // WHERE here would silently turn the LEFT JOIN into an inner join for
  // any placement whose only events fall outside the filtered window
  // (dropping it from the report instead of correctly showing it with
  // zero counts for that window).
  const eventFilter =
    eventConditions.length > 0 ? `AND ${eventConditions.join(" AND ")}` : "";

  const result = await query<{
    id: number;
    placement_key: string;
    impressions: string;
    clicks: string;
  }>(
    `SELECT
       p.id,
       p.placement_key,
       COUNT(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
       COUNT(*) FILTER (WHERE e.event_type = 'click') AS clicks
     FROM ad_placements p
     LEFT JOIN ad_events e ON e.placement_id = p.id ${eventFilter}
     GROUP BY p.id, p.placement_key
     ORDER BY p.placement_key ASC, p.id ASC`,
    params,
  );

  return result.rows.map((row) => ({
    placementId: row.id,
    placementKey: row.placement_key,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
  }));
}
