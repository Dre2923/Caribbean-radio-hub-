/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 28: events data quality - duplicate submission detection, the fifth
// step of the Events Database bucket, mirroring Step 16's near-duplicate
// stream URL detection for the same reason it existed there: an event is
// hand-typed by a real user (any authenticated user can submit one, unlike
// the admin-only station catalog), so the same real-world happening being
// submitted twice with only cosmetic differences in the title - extra
// whitespace, different letter case - is a genuine, expected failure mode,
// not a hypothetical one.
//
// This migration only adds the (nullable for now) column; the next
// migration backfills it and adds the constraint - the identical
// two-migration split already used for Step 02's countries, Step 13's
// genres/languages seed, and Step 16's stream_url_normalized, and for the
// same reason: pgm.addColumn here is deferred schema DSL that only
// actually runs once this function returns, so an immediate pgm.db.query
// UPDATE in the same migration would run against a table that, as far as
// the database is concerned, doesn't have this column yet.
exports.up = (pgm) => {
  pgm.addColumn("events", {
    title_normalized: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("events", "title_normalized");
};
