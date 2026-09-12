/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 18: station logo/artwork - the last piece of the Caribbean Radio
// Master Catalog bucket (Steps 12-18) before Stream Reliability (19-23).
// docs/BUILD_MANIFEST.md's Front-End Design Direction already names
// "station logos/artwork" as media the client has to handle correctly
// (proper codecs/formats, responsive sizing) - this is the metadata column
// that content actually comes from. Nullable and optional: a station
// without artwork yet is a normal, valid state, not an error.
//
// A single addColumn-only migration, not split in two: no backfill is
// needed (an existing row simply getting NULL is correct - "no artwork
// set yet"), so there's no immediate pgm.db.query to order against the
// deferred pgm.addColumn call - the hazard documented in
// docs/BUILD_MANIFEST.md's Cross-Cutting Non-Negotiables (hit for Steps
// 02/13/16) doesn't arise here, the same reasoning already applied to
// Step 17's deactivation-audit columns.
exports.up = (pgm) => {
  pgm.addColumn("radio_stations", {
    logo_url: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("radio_stations", "logo_url");
};
