/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 17: curation audit trail. Step 12's `is_active` flag already lets an
// admin pull a station from the public catalog without losing its history,
// but recorded nothing about *why* or *by whom* - an admin reviewing a
// deactivated station (or a future automated deactivation from Steps
// 19-23's stream-reliability monitoring) had no way to tell "a human
// decided this station was a duplicate" from "the stream has been down for
// a week" without separately remembering or looking elsewhere. All three
// columns are nullable and only ever populated as a side effect of
// deactivating a station (see stationsRepository.updateStation) - never
// independently editable - and are cleared again on reactivation, since a
// reason for being inactive stops applying once a station is active again.
// A single addColumn-only migration, not split in two: there is no
// backfill step here (existing rows simply get NULL, which is the correct
// "never deactivated" state), so there's no immediate pgm.db.query to
// order against the deferred pgm.addColumn calls - the exact hazard
// documented in docs/BUILD_MANIFEST.md's Cross-Cutting Non-Negotiables
// after being hit for Steps 02/13/16 simply doesn't arise here.
exports.up = (pgm) => {
  pgm.addColumn("radio_stations", {
    deactivated_at: { type: "timestamptz" },
    deactivated_by_user_id: {
      type: "integer",
      references: "users",
      onDelete: "SET NULL",
    },
    deactivation_reason: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("radio_stations", [
    "deactivated_at",
    "deactivated_by_user_id",
    "deactivation_reason",
  ]);
};
