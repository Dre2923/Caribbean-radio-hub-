// Step 62 (Background Update Workers, part one): the User Features digest.
// The second real trigger for Step 53's PushProvider, after Step 54's
// favorite-station-availability notifier - reuses the identical
// dependency-injection and per-recipient error-isolation shape that file
// already established, applied to a scheduled sweep instead of an
// event-driven call site.

import { listEvents } from "../repositories/eventsRepository.js";
import {
  listUsersDueForWeeklyDigest,
  markWeeklyDigestChecked,
} from "../repositories/notificationPreferencesRepository.js";
import { listPushTokensForUsers, deletePushTokenById } from "../repositories/pushTokensRepository.js";
import { createPushProvider } from "./provider.js";
import { InvalidPushTokenError, type PushProvider } from "./types.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

// A user is due again once this many days have passed since their last
// evaluation (or they've never been evaluated) - see
// listUsersDueForWeeklyDigest's own comment for why this is the caller's
// threshold to own, not something computed inside the repository.
const WEEKLY_DIGEST_INTERVAL_DAYS = 7;

// How many of a country's soonest upcoming events to name in the
// notification body - a digest that lists every upcoming event in a
// country over the coming weeks would be an unreadable wall of text, not
// a summary. Matches this API's own DEFAULT_EVENT_LIST_LIMIT-style
// "generous but bounded" posture without borrowing that specific constant,
// since a push notification's real constraint (screen space) is much
// tighter than a paginated list endpoint's.
const DIGEST_EVENT_COUNT = 5;

function buildDigestBody(eventTitles: string[], totalUpcoming: number): string {
  const named = eventTitles.join(", ");
  const remaining = totalUpcoming - eventTitles.length;
  return remaining > 0 ? `${named}, and ${remaining} more this week.` : `${named}.`;
}

// Guards against two sweeps overlapping - the identical module-level-flag
// pattern already used by both existing background workers
// (healthCheckWorker's sweepInProgress, autoDeactivationWorker's
// evaluationInProgress).
let sweepInProgress = false;

// Evaluates a given list of candidates (rather than querying for them
// itself) for the identical testability reason every other worker in this
// codebase takes its target list as a parameter: production passes the
// real due-for-a-digest set, a test passes a small, controlled one.
export async function evaluateWeeklyDigestCandidates(
  candidates: { userId: number; countryId: number }[],
  pushProvider: PushProvider = createPushProvider(),
): Promise<void> {
  for (const candidate of candidates) {
    try {
      // approved-only, upcoming-only, soonest-first - the identical filter
      // the public GET /v1/events route itself applies, so a digest never
      // names an event a listener couldn't also find (or use) themselves.
      const { events, total } = await listEvents({
        countryId: candidate.countryId,
        status: "approved",
        upcomingOnly: true,
        limit: DIGEST_EVENT_COUNT,
      });

      if (events.length > 0) {
        const pushTokens = await listPushTokensForUsers([candidate.userId]);
        if (pushTokens.length > 0) {
          const body = buildDigestBody(
            events.map((event) => event.title),
            total,
          );
          await Promise.all(
            pushTokens.map(async (pushToken) => {
              try {
                await pushProvider.send({
                  token: pushToken.token,
                  title: "This week's upcoming events",
                  body,
                  data: { type: "weekly_events_digest" },
                });
              } catch (err) {
                if (err instanceof InvalidPushTokenError) {
                  await deletePushTokenById(pushToken.id);
                } else {
                  logger.error("Failed to send a weekly events digest push notification", {
                    userId: candidate.userId,
                    pushTokenId: pushToken.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }),
          );
        }
      }
      // Always marked checked, even when there were zero upcoming events or
      // zero registered devices - see last_digest_check_at's own migration
      // comment for why "evaluated" and "a push actually went out" are
      // deliberately different things.
      await markWeeklyDigestChecked(candidate.userId);
    } catch (err) {
      logger.error("Weekly events digest evaluation failed for a user", {
        userId: candidate.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function runWeeklyEventsDigestSweep(): Promise<void> {
  if (sweepInProgress) {
    logger.warn("Weekly events digest sweep already in progress - skipping this tick");
    return;
  }
  sweepInProgress = true;
  try {
    const cutoff = new Date(
      Date.now() - WEEKLY_DIGEST_INTERVAL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const candidates = await listUsersDueForWeeklyDigest(cutoff);
    await evaluateWeeklyDigestCandidates(candidates);
  } finally {
    sweepInProgress = false;
  }
}

/**
 * Starts sweeping for due weekly digests on an interval. Returns a stop
 * function - index.ts calls it on SIGINT/SIGTERM, the same graceful-
 * shutdown discipline as every other background worker in this codebase.
 *
 * The sweep interval (env.weeklyEventsDigestIntervalMs, default 6h) is
 * deliberately much shorter than the 7-day digest window itself - the
 * identical "evaluate against a threshold on a much tighter tick, rather
 * than trying to precisely schedule exactly once a week per user"
 * reasoning as autoDeactivationWorker's own 1h-tick-against-a-48h-window
 * design, so a user becomes due within hours of crossing the 7-day mark
 * rather than waiting for one single weekly tick to land on them.
 */
export function startWeeklyEventsDigestWorker(): () => void {
  const interval = setInterval(() => {
    runWeeklyEventsDigestSweep().catch((err) => {
      logger.error("Weekly events digest worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.weeklyEventsDigestIntervalMs);

  interval.unref();

  return () => clearInterval(interval);
}
