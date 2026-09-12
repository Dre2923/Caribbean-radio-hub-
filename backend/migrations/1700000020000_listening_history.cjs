/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 52 (User Features, part two): listening history, the second piece
// of the bucket (Steps 51-55) alongside Step 51's favorites. The backend
// holds no server-side "now playing" state for any account (a listener's
// device connects directly to a station's own stream URL - the Project
// Standard's own no-proxy/no-rebroadcast rule already established this,
// and the Voice System's playback_control intent documentation restates
// it explicitly: "the backend holds no server-side 'now playing' state to
// act on"), so a listening-history record only ever exists because the
// client itself reports "I just started listening to this station" -
// there is no way for the backend to observe this on its own.
//
// Not a junction table like Step 51's favorites: a user can (and normally
// will) listen to the same station many times, so there's no natural
// composite-primary-key uniqueness here the way "did this user favorite
// this station" has. A plain serial-id table instead, with a supporting
// index on (user_id, listened_at DESC) for the "this user's history,
// most recent first" query every caller needs - the identical index shape
// stationHealthRepository's own (station_id, checked_at) index already
// established for the same "one row per event, most-recent-first per
// owner" access pattern (Step 19).
//
// station_id is nullable with ON DELETE SET NULL, not CASCADE - a
// deliberate difference from every other junction/reference table in this
// build, and worth spelling out why: a favorite (Step 51) is an
// *actionable* relationship ("this is one of my stations right now"), so
// it's correct for it to disappear along with the station it points to.
// A listening-history entry is a *historical* record ("I listened to
// something at 3pm yesterday") - that fact stays true even if the
// station itself is later hard-deleted (a rare event in this catalog;
// most curation is the soft isActive toggle, Step 17), so the row is
// preserved with a null station reference rather than being deleted out
// from under the user's own history. The identical "SET NULL preserves
// the historical row, CASCADE would erase real information" reasoning
// already applied to radio_stations.created_by_user_id and
// events.createdByUserId when the *user* is deleted; here it's applied to
// the *station* side of a different table for the same underlying reason.
// user_id itself is still CASCADE - deleting an account should remove
// that account's own history along with everything else it owns, the
// same posture as every other per-user table in this build.
//
// Deferred schema-DSL calls only (createTable/createIndex, no
// pgm.db.query) - not subject to the deferred-DDL-vs-immediate-query
// hazard.
exports.up = (pgm) => {
  pgm.createTable("listening_history", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    station_id: {
      type: "integer",
      references: "radio_stations",
      onDelete: "SET NULL",
    },
    listened_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex("listening_history", ["user_id", "listened_at"]);
};

exports.down = (pgm) => {
  pgm.dropTable("listening_history");
};
