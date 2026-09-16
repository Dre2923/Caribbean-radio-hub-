// Step 62 (Background Update Workers, part two): the Advertising
// performance rollup. See repositories/adPerformanceRepository.ts and
// migration 1700000027000_ad_performance_daily for the full design
// reasoning (why this exists alongside Step 57's real-time reporting, and
// why it stores only combinations that actually had activity).

import {
  computeAdEventCountsForDate,
  upsertAdPerformanceDaily,
} from "../repositories/adPerformanceRepository.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

// Yesterday's UTC calendar date as a 'YYYY-MM-DD' string. Always the
// *previous* full day, never "today" - today is still in progress, so
// rolling it up would need to be recomputed again later anyway (an
// unnecessary extra write) and could momentarily show a partial, still-
// climbing count that looks like a real final total but isn't. A UTC
// boundary (not the server's local time or any one country's own
// timezone) is the only boundary that's unambiguous for a Caribbean-wide
// catalog spanning multiple timezones.
export function yesterdayUtcDate(now: Date = new Date()): string {
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  return yesterday.toISOString().slice(0, 10);
}

// Takes the target date as a parameter (rather than always computing
// "yesterday" itself) for the identical reason every other worker's own
// core function does: production always rolls up yesterday, but a test
// needs to roll up a specific, controlled date without depending on
// whatever day it happens to run.
export async function runAdPerformanceRollup(date: string = yesterdayUtcDate()): Promise<void> {
  const counts = await computeAdEventCountsForDate(date);
  for (const row of counts) {
    try {
      await upsertAdPerformanceDaily(row.placementId, date, row.impressions, row.clicks);
    } catch (err) {
      logger.error("Ad performance rollup upsert failed for a placement", {
        placementId: row.placementId,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Starts the daily rollup on an interval. Returns a stop function -
 * index.ts calls it on SIGINT/SIGTERM, the same graceful-shutdown
 * discipline as every other background worker in this codebase.
 */
export function startAdPerformanceRollupWorker(): () => void {
  const interval = setInterval(() => {
    runAdPerformanceRollup().catch((err) => {
      logger.error("Ad performance rollup worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.adPerformanceRollupIntervalMs);

  interval.unref();

  return () => clearInterval(interval);
}
