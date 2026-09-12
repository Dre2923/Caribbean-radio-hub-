/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 16: radio station data quality - near-duplicate stream URL
// detection, layered on top of Step 12's exact-match `stream_url` UNIQUE
// constraint. Two different-looking URLs that are the exact same stream in
// every way that matters (a host typed in a different letter case, an
// incidental trailing slash on the root path) would otherwise both pass
// that exact-match check and silently create two catalog entries for one
// station - a real gap, not a hypothetical one, since these URLs are
// hand-typed or copy-pasted by admins. This migration only adds the
// (nullable for now) column; the next migration backfills it and adds the
// UNIQUE constraint - the identical two-migration split already used for
// Step 02's countries and Step 13's genres/languages seed, and for the
// same reason: pgm.addColumn here is deferred schema DSL that only
// actually runs once this function returns, so an immediate pgm.db.query
// UPDATE in the same migration would run against a table that, as far as
// the database is concerned, doesn't have this column yet.
exports.up = (pgm) => {
  pgm.addColumn("radio_stations", {
    stream_url_normalized: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("radio_stations", "stream_url_normalized");
};
