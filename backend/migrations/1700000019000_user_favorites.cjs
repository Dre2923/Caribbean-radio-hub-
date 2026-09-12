/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 51 (User Features, part one): the first step of the new bucket
// (Steps 51-55), per docs/ARCHITECTURE_PLAN.md Section 2's capability
// boundary ("51-55 User Features... Yes - pure backend"). Favorites is the
// foundational piece the rest of the bucket's personalization features
// (listening history, notification preferences) build alongside, the same
// "core data model first" shape Step 12 played for the Radio Master
// Catalog and Step 24 played for the Events Database.
//
// Two junction tables, not one polymorphic "favorites" table with a
// resource-type discriminator column: a genuine many-to-many between users
// and each of two distinct resource types (radio_stations, events), the
// same shape already established for station_genres/station_languages
// (Step 13) and event_category_assignments (Step 25) - a real foreign key
// to the correct target table on each side, not a loosely-typed
// (resource_type, resource_id) pair that the database itself can never
// validate or cascade correctly.
//
// Composite primary key (user_id, <resource>_id) on each: the pair *is*
// the whole fact ("this user favorited this station/event"), it doubles as
// the uniqueness constraint (a user can't favorite the same resource
// twice), and its leading column (user_id) already gives exactly the index
// shape "every favorite for this user" queries need - no separate index
// required, the identical reasoning already applied to
// event_category_assignments' composite key.
//
// CASCADE on both sides of both tables: deleting a user or a
// station/event should never leave an orphaned favorite row behind - the
// same cascade-on-delete posture already established for every other
// junction table in this build.
//
// created_at (not a Step-17/27-style xAt/xByUserId/xReason audit triplet):
// a favorite has no "reason" or "actor other than the user themselves" to
// audit - it's a simple, user-initiated preference, not a moderation/
// curation action. created_at is still genuinely useful on its own,
// though: favoritesRepository.ts orders a user's favorites list by it
// (most-recently-favorited first), the natural "show me my newest
// favorite" ordering a personal list actually wants.
//
// Deferred schema-DSL calls only (createTable, no pgm.db.query) - not
// subject to the deferred-DDL-vs-immediate-query hazard (checked, per the
// Cross-Cutting Non-Negotiable, on every new migration).
exports.up = (pgm) => {
  pgm.createTable("user_favorite_stations", {
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    station_id: {
      type: "integer",
      notNull: true,
      references: "radio_stations",
      onDelete: "CASCADE",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("user_favorite_stations", "user_favorite_stations_pkey", {
    primaryKey: ["user_id", "station_id"],
  });

  pgm.createTable("user_favorite_events", {
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    event_id: {
      type: "integer",
      notNull: true,
      references: "events",
      onDelete: "CASCADE",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("user_favorite_events", "user_favorite_events_pkey", {
    primaryKey: ["user_id", "event_id"],
  });
};

exports.down = (pgm) => {
  pgm.dropTable("user_favorite_events");
  pgm.dropTable("user_favorite_stations");
};
