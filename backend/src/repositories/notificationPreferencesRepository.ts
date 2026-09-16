// User Features (Step 54): notification preferences. See migration
// 1700000022000_notification_preferences's own comment for why "no row"
// and "explicitly set to the default" are deliberately indistinguishable
// from the outside - every function here folds a missing row into the
// same default a caller would get from an explicit one.

import { query } from "../db/pool.js";

export interface NotificationPreferences {
  favoriteStationAvailabilityChanges: boolean;
  // Step 62: see migration 1700000026000's own comment for why this
  // defaults to false, the opposite of the field above.
  weeklyEventsDigest: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  favoriteStationAvailabilityChanges: true,
  weeklyEventsDigest: false,
};

interface NotificationPreferencesRow {
  user_id: number;
  favorite_station_availability_changes: boolean;
  weekly_events_digest: boolean;
}

export async function getNotificationPreferences(userId: number): Promise<NotificationPreferences> {
  const result = await query<NotificationPreferencesRow>(
    "SELECT favorite_station_availability_changes, weekly_events_digest FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        favoriteStationAvailabilityChanges: row.favorite_station_availability_changes,
        weeklyEventsDigest: row.weekly_events_digest,
      }
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
    `INSERT INTO notification_preferences
       (user_id, favorite_station_availability_changes, weekly_events_digest, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET favorite_station_availability_changes = EXCLUDED.favorite_station_availability_changes,
           weekly_events_digest = EXCLUDED.weekly_events_digest,
           updated_at = now()`,
    [userId, merged.favoriteStationAvailabilityChanges, merged.weeklyEventsDigest],
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
    "SELECT user_id, favorite_station_availability_changes, weekly_events_digest FROM notification_preferences WHERE user_id = ANY($1)",
    [userIds],
  );
  for (const row of rows.rows) {
    result.set(row.user_id, {
      favoriteStationAvailabilityChanges: row.favorite_station_availability_changes,
      weeklyEventsDigest: row.weekly_events_digest,
    });
  }
  return result;
}

// Step 62: the weekly digest worker's own candidate query. Joins against
// users (not just notification_preferences) for two reasons: country_id
// lives on users, not here, and a user with no notification_preferences
// row at all must never be a candidate - unlike
// favoriteStationAvailabilityChanges, weeklyEventsDigest's default is
// false (see migration 1700000026000's own comment), so "no row" correctly
// means "never opted in," the inner JOIN itself is enough to exclude that
// case without a separate check.
//
// cutoff is the caller's own "due again" boundary (now() minus the
// worker's own re-check interval) - passed in rather than computed here so
// the worker's own interval constant stays the single source of truth and
// this function stays trivially testable with an arbitrary cutoff.
export interface WeeklyDigestCandidate {
  userId: number;
  countryId: number;
}

export async function listUsersDueForWeeklyDigest(cutoff: string): Promise<WeeklyDigestCandidate[]> {
  const result = await query<{ user_id: number; country_id: number }>(
    `SELECT u.id AS user_id, u.country_id
     FROM users u
     JOIN notification_preferences np ON np.user_id = u.id
     WHERE np.weekly_events_digest = true
       AND u.country_id IS NOT NULL
       AND (np.last_digest_check_at IS NULL OR np.last_digest_check_at < $1)
     ORDER BY u.id ASC`,
    [cutoff],
  );
  return result.rows.map((row) => ({ userId: row.user_id, countryId: row.country_id }));
}

// Marks a user as evaluated for this week's digest - see
// last_digest_check_at's own migration comment for why this is called
// regardless of whether there was anything to actually push.
export async function markWeeklyDigestChecked(userId: number): Promise<void> {
  await query("UPDATE notification_preferences SET last_digest_check_at = now() WHERE user_id = $1", [
    userId,
  ]);
}
