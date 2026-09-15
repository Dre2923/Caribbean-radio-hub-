/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 54 (User Features, part four): notification preferences, plus
// wiring Step 53's PushProvider to its first real trigger - notifying a
// user when a station they favorited (Step 51) becomes unavailable or
// comes back, the concrete, well-scoped feature this bucket's remaining
// pieces (favorites, push infrastructure) already exist to support.
//
// One row per user, not a junction/lookup table - a user's notification
// preferences are inherently 1:1 with their account, the same "a profile
// extension, not a many-to-many relationship" shape as users itself.
// user_id is both the primary key and the foreign key (not a separate
// serial id) - there is exactly one preferences row per user by
// definition, so a composite or auto-incrementing id would only add an
// unused column. ON DELETE CASCADE - deleting an account removes its
// preferences along with everything else it owns.
//
// No row is created at registration time; GET /v1/me/notification-
// preferences (routes/notificationPreferences.ts) returns the default
// (favorite_station_availability_changes: true) for any user with no row
// yet, and PATCH creates one lazily on first customization (upsert) - so
// "no preferences row" and "explicitly set to the default value" are
// deliberately indistinguishable from the outside, the simplest possible
// contract for a feature with exactly one preference so far.
//
// Deferred schema-DSL calls only (createTable, no pgm.db.query) - not
// subject to the deferred-DDL-vs-immediate-query hazard.
exports.up = (pgm) => {
  pgm.createTable("notification_preferences", {
    user_id: {
      type: "integer",
      notNull: true,
      primaryKey: true,
      references: "users",
      onDelete: "CASCADE",
    },
    favorite_station_availability_changes: {
      type: "boolean",
      notNull: true,
      default: true,
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("notification_preferences");
};
