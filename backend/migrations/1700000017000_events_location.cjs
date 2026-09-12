/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 30: structured location data - the seventh and final step of the
// Events Database bucket, completing its core data model before Admin
// Dashboard/Voice/Client work builds on top of it. `venue` (since Step 24)
// is a free-text name ("National Stadium") with nothing a map view or a
// "near me" search could act on - a real events platform needs an actual
// address and, optionally, coordinates to support proximity discovery
// (the Project Standard's "discovery" pillar this whole bucket serves).
//
// venue_address is a fuller street/city address, distinct from the venue
// NAME already stored in `venue` - both are useful together ("National
// Stadium", "Arthur Wint Drive, Kingston"). latitude/longitude are
// optional (not every submission will have exact coordinates ready) but
// deliberately constrained at the database level, not just the
// application layer, per the "assume every input is hostile" standard:
// - both or neither, never one without the other (a lone coordinate is
//   meaningless and would silently corrupt a distance calculation)
// - each within its real-world valid range
//
// A single addColumn+addConstraint migration, not split in two: there is
// no backfill step here (an existing row simply gets NULL across all
// three, which is the correct "no structured location given yet" state),
// so there's no immediate pgm.db.query to order against the deferred DSL
// calls - the exact hazard documented in docs/BUILD_MANIFEST.md's
// Cross-Cutting Non-Negotiables simply doesn't arise here.
exports.up = (pgm) => {
  pgm.addColumn("events", {
    venue_address: { type: "text" },
    latitude: { type: "double precision" },
    longitude: { type: "double precision" },
  });

  pgm.addConstraint("events", "events_location_lat_long_together", {
    check: '("latitude" IS NULL) = ("longitude" IS NULL)',
  });
  pgm.addConstraint("events", "events_latitude_range", {
    check: '"latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)',
  });
  pgm.addConstraint("events", "events_longitude_range", {
    check: '"longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180)',
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("events", "events_longitude_range");
  pgm.dropConstraint("events", "events_latitude_range");
  pgm.dropConstraint("events", "events_location_lat_long_together");
  pgm.dropColumn("events", ["venue_address", "latitude", "longitude"]);
};
