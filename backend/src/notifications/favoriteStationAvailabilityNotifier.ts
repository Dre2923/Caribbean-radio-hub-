// Step 54: the first real trigger for Step 53's PushProvider - notifying
// every user who favorited a station (Step 51) the moment that station
// becomes unavailable or comes back, whether the change was a human
// admin's PATCH (routes/stations.ts) or the automatic stream-reliability
// monitor (stationHealth/autoDeactivationWorker.ts). Both call sites share
// this one function rather than duplicating the fan-out logic, the same
// "one orchestration point, not one per caller" reasoning already applied
// to error-mapping helpers throughout this codebase.

import { listStationFavoriterUserIds } from "../repositories/favoritesRepository.js";
import { listNotificationPreferencesForUsers } from "../repositories/notificationPreferencesRepository.js";
import { listPushTokensForUsers, deletePushTokenById } from "../repositories/pushTokensRepository.js";
import { createPushProvider } from "./provider.js";
import { InvalidPushTokenError, type PushProvider } from "./types.js";
import { logger } from "../utils/logger.js";

// pushProvider is a parameter (defaulting to createPushProvider()) for the
// identical dependency-injection reason already applied throughout this
// codebase (createEmailProvider, the background workers' given-a-list
// pattern) - a test exercises this against an injected fake provider
// rather than either hitting a real FCM endpoint or monkey-patching a
// module-level singleton.
export async function notifyFavoriteStationAvailabilityChange(
  stationId: number,
  stationName: string,
  isNowActive: boolean,
  pushProvider: PushProvider = createPushProvider(),
): Promise<void> {
  try {
    const favoriterUserIds = await listStationFavoriterUserIds(stationId);
    if (favoriterUserIds.length === 0) return;

    const preferencesByUser = await listNotificationPreferencesForUsers(favoriterUserIds);
    const optedInUserIds = favoriterUserIds.filter(
      (userId) => preferencesByUser.get(userId)?.favoriteStationAvailabilityChanges ?? true,
    );
    if (optedInUserIds.length === 0) return;

    const pushTokens = await listPushTokensForUsers(optedInUserIds);
    if (pushTokens.length === 0) return;

    const title = isNowActive ? "Your favorite station is back" : "Your favorite station is unavailable";
    const body = isNowActive
      ? `${stationName} is streaming again.`
      : `${stationName} is temporarily unavailable.`;

    // Every token is sent independently, and one token's own failure is
    // isolated from the rest of the fan-out - the identical
    // error-isolation reasoning already applied to Step 20's
    // sweepStations, so one dead/unregistered device can never stop a
    // notification from reaching everyone else who favorited this station.
    await Promise.all(
      pushTokens.map(async (pushToken) => {
        try {
          await pushProvider.send({
            token: pushToken.token,
            title,
            body,
            data: { stationId: String(stationId), isActive: String(isNowActive) },
          });
        } catch (err) {
          if (err instanceof InvalidPushTokenError) {
            // The provider itself says this token is permanently dead
            // (uninstalled app, rotated/expired token) - clean it up now
            // rather than repeatedly failing to notify a device that will
            // never receive it again.
            await deletePushTokenById(pushToken.id);
          } else {
            logger.error("Failed to send favorite-station-availability push notification", {
              stationId,
              pushTokenId: pushToken.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }),
    );
  } catch (err) {
    // This entire notification fan-out is a best-effort side effect of a
    // station's isActive change, never something that should fail the
    // update itself - the same "a component that can degrade gracefully
    // should, rather than propagating a hard crash" standard already
    // applied throughout this build's background workers.
    logger.error("Favorite-station-availability notification fan-out failed", {
      stationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
