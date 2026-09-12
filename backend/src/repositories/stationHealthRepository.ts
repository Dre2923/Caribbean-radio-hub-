import { query } from "../db/pool.js";
import type { StreamHealthCheckResult } from "../utils/streamHealthCheck.js";

export interface StationHealthCheck {
  id: number;
  stationId: number;
  checkedAt: string;
  isReachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

interface StationHealthCheckRow {
  id: number;
  station_id: number;
  checked_at: string;
  is_reachable: boolean;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
}

function toStationHealthCheck(row: StationHealthCheckRow): StationHealthCheck {
  return {
    id: row.id,
    stationId: row.station_id,
    checkedAt: row.checked_at,
    isReachable: row.is_reachable,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
  };
}

// Persists exactly the result checkStreamHealth already measured - this
// function never re-derives or re-validates that result, it's purely the
// storage half of "run a check, then record it," kept as a separate step
// so a future caller (Step 20's background worker included) can run many
// checks and record each independently without recomputing anything.
export async function recordHealthCheck(
  stationId: number,
  result: StreamHealthCheckResult,
): Promise<StationHealthCheck> {
  const inserted = await query<StationHealthCheckRow>(
    `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, station_id, checked_at, is_reachable, status_code, latency_ms, error`,
    [stationId, result.isReachable, result.statusCode, result.latencyMs, result.error],
  );
  return toStationHealthCheck(inserted.rows[0]);
}

// Most-recent-first, capped rather than unbounded - an admin history view
// (or this same function reused by a future ranking computation) should
// never be able to trigger an unbounded scan of a table that only grows
// over time.
const DEFAULT_HEALTH_CHECK_HISTORY_LIMIT = 20;
const MAX_HEALTH_CHECK_HISTORY_LIMIT = 100;

export async function listHealthChecks(
  stationId: number,
  limit: number = DEFAULT_HEALTH_CHECK_HISTORY_LIMIT,
): Promise<StationHealthCheck[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), MAX_HEALTH_CHECK_HISTORY_LIMIT);
  const result = await query<StationHealthCheckRow>(
    `SELECT id, station_id, checked_at, is_reachable, status_code, latency_ms, error
     FROM station_health_checks
     WHERE station_id = $1
     ORDER BY checked_at DESC
     LIMIT $2`,
    [stationId, cappedLimit],
  );
  return result.rows.map(toStationHealthCheck);
}

export interface StationReliability {
  stationId: number;
  windowHours: number;
  totalChecks: number;
  reachableChecks: number;
  // null (not 0) when totalChecks is 0 - "no data yet" is a meaningfully
  // different state from "checked and found down every time," and
  // conflating the two would let a station with zero history rank
  // identically to one with a confirmed-bad track record.
  uptimePercentage: number | null;
  // Averaged over reachable checks only - an unreachable check's latencyMs
  // measures how long it took to fail, not how fast a working stream
  // responds, so mixing the two in would distort the signal rather than
  // add to it. null when there are no reachable checks to average.
  averageLatencyMs: number | null;
}

export const DEFAULT_RELIABILITY_WINDOW_HOURS = 24;

interface ReliabilityAggregateRow {
  total_checks: string;
  reachable_checks: string;
  average_latency_ms: string | null;
}

// Shared by getStationReliability and getRankedStationReliabilityForCountry
// so the two never quietly drift into computing "uptime percentage" or
// "average latency" slightly differently from each other.
function toReliabilitySummary(
  stationId: number,
  windowHours: number,
  row: ReliabilityAggregateRow,
): StationReliability {
  const totalChecks = Number(row.total_checks);
  const reachableChecks = Number(row.reachable_checks);
  return {
    stationId,
    windowHours,
    totalChecks,
    reachableChecks,
    uptimePercentage: totalChecks > 0 ? (reachableChecks / totalChecks) * 100 : null,
    averageLatencyMs:
      row.average_latency_ms !== null ? Math.round(Number(row.average_latency_ms)) : null,
  };
}

// Step 21: the aggregate signal the per-country quality ranking (Step 22)
// is actually built on - Step 19/20 only ever produced individual,
// point-in-time check rows; a ranking needs one comparable number per
// station, computed from "that day's" history the way
// docs/BUILD_MANIFEST.md's "Radio Station Quality Ranking" describes it,
// not a one-time/static ordering.
export async function getStationReliability(
  stationId: number,
  windowHours: number = DEFAULT_RELIABILITY_WINDOW_HOURS,
): Promise<StationReliability> {
  const result = await query<ReliabilityAggregateRow>(
    `SELECT
       COUNT(*) AS total_checks,
       COUNT(*) FILTER (WHERE is_reachable) AS reachable_checks,
       AVG(latency_ms) FILTER (WHERE is_reachable) AS average_latency_ms
     FROM station_health_checks
     WHERE station_id = $1 AND checked_at >= now() - make_interval(hours => $2)`,
    [stationId, windowHours],
  );
  return toReliabilitySummary(stationId, windowHours, result.rows[0]);
}

// Step 22: the same aggregation as getStationReliability, but computed for
// every active station in a country in one query and already ordered by
// the ranking rule the per-country quality ranking needs: known
// reliability (real checks exist) beats unknown, highest uptime first,
// lower average latency breaks a tie, station name breaks any remaining
// tie for full determinism. Deliberately conservative about unknown
// stations - a station with zero recorded checks could be broken (a typo
// in its streamUrl, wrong port, anything Step 20's sweep just hasn't
// caught yet) just as easily as it could be fine, so it's ranked *after*
// every station this system has actually verified, even one with a
// mediocre-but-real track record - trusting measured evidence over no
// evidence at all, not assuming the best of an unverified stream.
export async function getRankedStationReliabilityForCountry(
  countryId: number,
  windowHours: number = DEFAULT_RELIABILITY_WINDOW_HOURS,
): Promise<StationReliability[]> {
  const result = await query<{ id: number } & ReliabilityAggregateRow>(
    `SELECT
       s.id,
       COUNT(hc.id) AS total_checks,
       COUNT(hc.id) FILTER (WHERE hc.is_reachable) AS reachable_checks,
       AVG(hc.latency_ms) FILTER (WHERE hc.is_reachable) AS average_latency_ms
     FROM radio_stations s
     LEFT JOIN station_health_checks hc
       ON hc.station_id = s.id AND hc.checked_at >= now() - make_interval(hours => $2)
     WHERE s.country_id = $1 AND s.is_active = true
     GROUP BY s.id
     ORDER BY
       (CASE WHEN COUNT(hc.id) > 0
             THEN COUNT(hc.id) FILTER (WHERE hc.is_reachable)::float8 / COUNT(hc.id)
             ELSE NULL END) DESC NULLS LAST,
       AVG(hc.latency_ms) FILTER (WHERE hc.is_reachable) ASC NULLS LAST,
       s.name ASC`,
    [countryId, windowHours],
  );
  return result.rows.map((row) => toReliabilitySummary(row.id, windowHours, row));
}
