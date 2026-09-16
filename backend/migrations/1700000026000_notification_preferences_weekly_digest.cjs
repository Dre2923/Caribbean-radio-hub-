/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 62 (Background Update Workers, part one): the User Features digest.
// docs/ARCHITECTURE_PLAN.md scoped this step as needing a real candidate
// job that "didn't exist before Step 51" - a weekly summary of upcoming
// events in a user's own profile country (Step 26's events catalog +
// Step 04's users.country_id) is exactly that, and reuses Step 53's
// PushProvider infrastructure exactly the way Step 54's favorite-station-
// availability notifier already does.
//
// Two new columns on the existing notification_preferences table (Step 54)
// rather than a new table - this is still a 1:1 per-user preference, the
// same shape as favorite_station_availability_changes, so it belongs on
// the same row.
//
// weekly_events_digest defaults to FALSE, the opposite of
// favorite_station_availability_changes' own TRUE default: that one is a
// transactional notice about something the user explicitly opted into
// (favoriting a station) going up or down, the same "on by default, easy
// to turn off" posture as any transactional alert. A weekly digest is
// unsolicited, recurring marketing-shaped content nobody asked for yet -
// real industry practice (CAN-SPAM's own opt-in guidance for non-
// transactional digests, and every major app's own "weekly summary"
// toggle) defaults that kind of notification to off until a user
// specifically asks for it.
//
// last_digest_check_at (nullable, no default - NULL means "never
// evaluated") is deliberately named "check", not "sent": the worker
// (src/notifications/weeklyEventsDigestWorker.ts) updates it every time it
// evaluates a user for that week's digest, whether or not there actually
// were any upcoming events worth pushing - the same "mark this as
// considered so the next tick doesn't redundantly re-evaluate the same
// user" reasoning as autoDeactivationWorker's evaluationInProgress guard,
// just per-user and persisted instead of a single in-memory flag. Naming
// it "sent" would be actively misleading for the (common) case of a user
// opted in but with nothing upcoming in their country that week.
exports.up = (pgm) => {
  pgm.addColumns("notification_preferences", {
    weekly_events_digest: {
      type: "boolean",
      notNull: true,
      default: false,
    },
    last_digest_check_at: {
      type: "timestamptz",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("notification_preferences", ["weekly_events_digest", "last_digest_check_at"]);
};
