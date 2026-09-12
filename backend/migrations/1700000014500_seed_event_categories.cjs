/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// A representative starter set, not an exhaustive taxonomy - this table is
// meant to keep growing via ordinary INSERTs as curation needs more
// entries, the same "database-driven" spirit as genres/languages before it
// (Step 13) and countries before that.
const EVENT_CATEGORIES = [
  "Carnival",
  "Festival",
  "Concert",
  "Cultural",
  "Community",
  "Sports",
  "Nightlife",
  "Food & Drink",
  "Family",
  "Religious",
  "Comedy",
  "Theatre & Arts",
];

// pgm.db.query executes immediately with real $1 parameter binding, run
// only after the previous migration's table creation has actually flushed
// - see that migration's comment for why the two can't be combined.
exports.up = async (pgm) => {
  for (const name of EVENT_CATEGORIES) {
    await pgm.db.query("INSERT INTO event_categories (name) VALUES ($1)", [name]);
  }
};

exports.down = async (pgm) => {
  await pgm.db.query("DELETE FROM event_categories WHERE name = ANY($1)", [EVENT_CATEGORIES]);
};
