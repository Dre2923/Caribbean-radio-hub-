// User Features (Step 54): notification preferences. See migration
// 1700000022000_notification_preferences's own comment for why "no row"
// and "explicitly set to the default" are deliberately indistinguishable
// from the outside - every function here folds a missing row into the
// same default a caller would get from an explicit one.

import { query } from "../db/pool.js";

export interface NotificationPreferences {
  favoriteStationAvailabilityChanges: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  favoriteStationAvailabilityChanges: true,
};

interface NotificationPreferencesRow {
  user_id: number;
  favorite_station_availability_changes: boolean;
}

export async function getNotificationPreferences(userId: number): Promise<NotificationPreferences> {
  const result = await query<NotificationPreferencesRow>(
    "SELECT favorite_station_availability_changes FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  return row
    ? { favoriteStationAvailabilityChanges: row.favorite_station_availability_changes }
    : { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

// Merge-then-upsert, not a partial UPDATE: with a single preference today
// this is equivalent either way, but this shape is what stays correct
// once a second preference is added later (an update touching only field
// A must never accidentally reset field B to a hardcoded default for a
// user who had no row yet) - the same "only the fields present are
// changed" contract PATCH /v1/me already holds itself to.
export async function updateNotificationPreferences(
  userId: number,
  updates: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferences(userId);
  const merged: NotificationPreferences = { ...current, ...updates };
  await query(
    `INSERT INTO notification_preferences (user_id, favorite_station_availability_changes, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
       SET favorite_station_availability_changes = EXCLUDED.favorite_station_availability_changes,
           updated_at = now()`,
    [userId, merged.favoriteStationAvailabilityChanges],
  );
  return merged;
}

// Bulk lookup for the notification fan-out
// (favoriteStationAvailabilityNotifier.ts): one round trip for a whole
// batch of users rather than one query per user. Every requested id is
// present in the returned map - a user with no row gets the same default
// getNotificationPreferences would give them - so a caller never needs a
// separate "was this id even in the result" check.
export async function listNotificationPreferencesForUsers(
  userIds: number[],
): Promise<Map<number, NotificationPreferences>> {
  const result = new Map<number, NotificationPreferences>();
  for (const userId of userIds) {
    result.set(userId, { ...DEFAULT_NOTIFICATION_PREFERENCES });
  }
  if (userIds.length === 0) return result;

  const rows = await query<NotificationPreferencesRow>(
    "SELECT user_id, favorite_station_availability_changes FROM notification_preferences WHERE user_id = ANY($1)",
    [userIds],
  );
  for (const row of rows.rows) {
    result.set(row.user_id, {
      favoriteStationAvailabilityChanges: row.favorite_station_availability_changes,
    });
  }
  return result;
}
