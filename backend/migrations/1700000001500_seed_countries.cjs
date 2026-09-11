/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Launch countries, kept database-driven so more can be added later
// without a rebuild or code change.
const LAUNCH_COUNTRIES = [
  { code: "JM", name: "Jamaica" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "DM", name: "Dominica" },
  { code: "LC", name: "Saint Lucia" },
  { code: "GD", name: "Grenada" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "BB", name: "Barbados" },
  { code: "PR", name: "Puerto Rico" },
  { code: "VC", name: "Saint Vincent & the Grenadines" },
  { code: "KN", name: "Saint Kitts & Nevis" },
  { code: "AI", name: "Anguilla" },
  { code: "TC", name: "Turks and Caicos" },
  { code: "BS", name: "Bahamas" },
];

// Seed data lives in its own migration, run after the countries table is
// created (previous migration) and fully flushed. pgm.db.query executes
// immediately against the DB with real $1/$2 parameter binding - the same
// driver-level binding the application code uses - rather than string
// interpolation. It cannot be combined with pgm.createTable in one
// migration: that call only queues SQL that flushes after `up()` returns,
// so an immediate query in the same function would run before the table
// exists.
exports.up = async (pgm) => {
  for (const country of LAUNCH_COUNTRIES) {
    await pgm.db.query("INSERT INTO countries (code, name) VALUES ($1, $2)", [
      country.code,
      country.name,
    ]);
  }
};

exports.down = async (pgm) => {
  const codes = LAUNCH_COUNTRIES.map((country) => country.code);
  await pgm.db.query("DELETE FROM countries WHERE code = ANY($1)", [codes]);
};
