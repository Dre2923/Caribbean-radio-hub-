/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// A representative starter set for the 13 launch countries, not an
// exhaustive taxonomy - both tables are meant to keep growing via ordinary
// INSERTs as curation needs more entries, the same "database-driven" spirit
// as the countries list itself.
const GENRES = [
  "Reggae",
  "Dancehall",
  "Soca",
  "Calypso",
  "Zouk",
  "Kompa",
  "Reggaeton",
  "Salsa",
  "Merengue",
  "Gospel",
  "Talk & News",
  "Culture & Variety",
];

// English is the primary/official language across all 13 launch countries;
// Spanish (Puerto Rico) and French Creole (Saint Lucia, Dominica) are the
// other languages actually spoken on-air in that list today. French is
// included alongside French Creole since Creole-speaking stations
// frequently also broadcast segments in standard French.
const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "fr-CR", name: "French Creole" },
];

// pgm.db.query executes immediately with real $1/$2 parameter binding, run
// only after the previous migration's table creation has actually flushed
// - see that migration's comment for why the two can't be combined.
exports.up = async (pgm) => {
  for (const name of GENRES) {
    await pgm.db.query("INSERT INTO genres (name) VALUES ($1)", [name]);
  }
  for (const language of LANGUAGES) {
    await pgm.db.query("INSERT INTO languages (code, name) VALUES ($1, $2)", [
      language.code,
      language.name,
    ]);
  }
};

exports.down = async (pgm) => {
  const genreNames = GENRES;
  const languageCodes = LANGUAGES.map((language) => language.code);
  await pgm.db.query("DELETE FROM genres WHERE name = ANY($1)", [genreNames]);
  await pgm.db.query("DELETE FROM languages WHERE code = ANY($1)", [languageCodes]);
};
