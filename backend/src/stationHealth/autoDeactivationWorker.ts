import { listActiveStationsForHealthCheck, updateStation } from "../repositories/stationsRepository.js";
import { getStationReliability, type StationReliability } from "../repositories/stationHealthRepository.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

// Step 23: closes the loop between Step 21's reliability scoring and Step
// 17's curation audit trail. Steps 19-22 all treat an unreliable station
// as something to route *around* (the ranking already puts it last in the
// fallback chain) - none of them ever stop it from still cluttering the
// public catalog (GET /v1/stations, search results) indefinitely. A
// station confirmed completely dead for days should get curated off
// automatically rather than waiting for an admin to happen to notice.
//
// Deliberately conservative on both axes, to keep an automated system from
// ever mistaking a brief outage for a dead station:
// - A long window (48h, not Step 21's 24h "that day" default) - two full
//   days of nothing but failure, not one bad day.
// - A meaningful sample size floor - a handful of checks during, say, a
//   deploy window or a transient DNS blip must never be enough evidence on
//   their own.
// - Exactly 0% uptime, never "mostly down" - this only ever acts on
//   stations with zero successful checks in the entire window, the same
//   "never assume the best, but also never overreach past what's actually
//   proven" caution already applied to Step 22's unknown-station ranking.
const AUTO_DEACTIVATION_WINDOW_HOURS = 48;
const AUTO_DEACTIVATION_MIN_CHECKS = 20;

export function shouldAutoDeactivate(reliability: StationReliability): boolean {
  return (
    reliability.totalChecks >= AUTO_DEACTIVATION_MIN_CHECKS && reliability.uptimePercentage === 0
  );
}

function buildAutoDeactivationReason(reliability: StationReliability): string {
  return (
    "Automatically deactivated by the stream-reliability monitor: 0% uptime across " +
    `${reliability.totalChecks} checks over the last ${reliability.windowHours}h.`
  );
}

// Guards against two evaluation runs overlapping - the same reasoning and
// the same simple module-level flag as Step 20's sweepInProgress.
let evaluationInProgress = false;

// Evaluates a given list of station ids against the auto-deactivation
// rule and curates off any that qualify. Takes ids as a parameter (rather
// than listing the catalog itself) for the identical reason Step 20's
// sweepStations does: the real production path evaluates the whole active
// catalog, but a test needs to evaluate a small, controlled list without
// depending on - or being slowed down by - however large the shared
// catalog has grown. Each station's own evaluation is independent; one
// station's lookup or update failing must never stop the rest from being
// evaluated.
export async function evaluateStationsForAutoDeactivation(stationIds: number[]): Promise<void> {
  if (evaluationInProgress) {
    logger.warn("Auto-deactivation evaluation already in progress - skipping this tick");
    return;
  }
  evaluationInProgress = true;
  try {
    for (const stationId of stationIds) {
      try {
        const reliability = await getStationReliability(stationId, AUTO_DEACTIVATION_WINDOW_HOURS);
        if (shouldAutoDeactivate(reliability)) {
          // actorUserId: null - no human made this decision. Recorded that
          // way in deactivated_by_user_id (nullable since Step 17
          // specifically to support this), so an admin reviewing curated-
          // off stations can immediately tell an automatic deactivation
          // apart from one they or a colleague made by hand.
          await updateStation(
            stationId,
            { isActive: false, deactivationReason: buildAutoDeactivationReason(reliability) },
            null,
          );
          logger.warn("Automatically deactivated a persistently unreachable station", {
            stationId,
            totalChecks: reliability.totalChecks,
            windowHours: reliability.windowHours,
          });
        }
      } catch (err) {
        logger.error("Auto-deactivation evaluation failed for a station", {
          stationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    evaluationInProgress = false;
  }
}

export async function runAutoDeactivationSweep(): Promise<void> {
  const stations = await listActiveStationsForHealthCheck();
  await evaluateStationsForAutoDeactivation(stations.map((station) => station.id));
}

/**
 * Starts the auto-deactivation evaluation on an interval. Returns a stop
 * function - index.ts calls it on SIGINT/SIGTERM, the same graceful-
 * shutdown discipline as the email outbox and health-check workers.
 */
export function startAutoDeactivationWorker(): () => void {
  const interval = setInterval(() => {
    runAutoDeactivationSweep().catch((err) => {
      logger.error("Auto-deactivation worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.stationAutoDeactivationIntervalMs);

  interval.unref();

  return () => clearInterval(interval);
}
