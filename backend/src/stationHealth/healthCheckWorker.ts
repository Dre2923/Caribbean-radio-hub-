import {
  listActiveStationsForHealthCheck,
  type StationHealthCheckTarget,
} from "../repositories/stationsRepository.js";
import { recordHealthCheck } from "../repositories/stationHealthRepository.js";
import { checkStreamHealth } from "../utils/streamHealthCheck.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

// A real outbound network request per active station, all at once, would
// both be a poor way to treat real third-party stream servers and risk
// exhausting local resources (sockets, file descriptors) as the catalog
// grows. A small fixed pool of "workers" pulling from a shared index
// bounds how many checks run concurrently without needing an extra
// dependency for something this simple.
const SWEEP_CONCURRENCY = 5;

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// Guards against two sweeps overlapping - if a previous sweep is still
// running (a slow/large catalog, or several stations hitting the full
// timeout) when the next scheduled tick fires, running a second one at the
// same time would double up in-flight requests to the same stations for no
// benefit. A plain module-level flag is enough since this worker only ever
// has one instance per process.
let sweepInProgress = false;

// Runs one check against every given station and records the result. Each
// station's outcome is independent - checkStreamHealth already never
// throws (it turns every failure mode, including its own timeout, into a
// result rather than an exception), but recordHealthCheck's database write
// still could, and one station's DB hiccup must never stop the rest of the
// sweep from running. Takes the target list as a parameter (rather than
// listing the catalog itself) so it's the same function in production
// (given the real active catalog) and in tests (given a small, controlled
// list) - not two different code paths.
export async function sweepStations(stations: StationHealthCheckTarget[]): Promise<void> {
  if (sweepInProgress) {
    logger.warn("Health check sweep already in progress - skipping this tick");
    return;
  }
  sweepInProgress = true;
  try {
    await runWithConcurrencyLimit(stations, SWEEP_CONCURRENCY, async (station) => {
      try {
        const result = await checkStreamHealth(station.streamUrl);
        await recordHealthCheck(station.id, result);
      } catch (err) {
        logger.error("Failed to record a station's health check during a sweep", {
          stationId: station.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } finally {
    sweepInProgress = false;
  }
}

export async function runHealthCheckSweep(): Promise<void> {
  await sweepStations(await listActiveStationsForHealthCheck());
}

/**
 * Starts sweeping the active catalog on an interval. Returns a stop
 * function - index.ts calls it on SIGINT/SIGTERM, the same graceful-
 * shutdown discipline already applied to the email outbox worker.
 */
export function startHealthCheckWorker(): () => void {
  const interval = setInterval(() => {
    runHealthCheckSweep().catch((err) => {
      logger.error("Health check worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.stationHealthCheckIntervalMs);

  // Never let this timer alone keep the process alive - matters for tests
  // and any short-lived script that imports this module.
  interval.unref();

  return () => clearInterval(interval);
}
