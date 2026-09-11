/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 13: station metadata taxonomy. Both genres and languages are
// database-driven lookup tables - the same "seed a starter set, add more
// later without a code change" pattern already used for countries - rather
// than a hardcoded enum, since Caribbean radio's genre/language mix is
// exactly the kind of thing curators will keep expanding.
//
// A station can have more than one of each (a station is rarely "only"
// one genre, and several of the 13 launch countries are functionally
// bilingual - Saint Lucia and Dominica's French Creole alongside English,
// Puerto Rico's Spanish and English), so both are many-to-many junction
// tables, not columns on radio_stations itself.
//
// Seed data lives in the next migration, not here: pgm.createTable/
// addConstraint/createIndex only queue SQL that flushes after this
// function returns, so an immediate pgm.db.query seed insert in the same
// migration would run before these tables actually exist (the exact bug
// already hit and fixed once for countries - see
// 1700000001000_countries.cjs / 1700000001500_seed_countries.cjs).
exports.up = (pgm) => {
  pgm.createTable("genres", {
    id: "id",
    name: { type: "varchar(60)", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createTable("languages", {
    id: "id",
    code: { type: "varchar(10)", notNull: true, unique: true },
    name: { type: "varchar(60)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // Composite primary key, not a surrogate id - the pair is the whole
  // fact ("this station has this genre"), and it also doubles as the
  // uniqueness constraint that stops the same genre being attached to a
  // station twice. CASCADE on both sides: deleting a station should drop
  // its tag associations along with it, and (though genres/languages have
  // no delete path yet) so should retiring a genre/language.
  pgm.createTable("station_genres", {
    station_id: {
      type: "integer",
      notNull: true,
      references: "radio_stations",
      onDelete: "CASCADE",
    },
    genre_id: {
      type: "integer",
      notNull: true,
      references: "genres",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("station_genres", "station_genres_pkey", {
    primaryKey: ["station_id", "genre_id"],
  });
  // The station->genres direction (used on every station read) is covered
  // by the primary key's leading column; the reverse direction (which
  // stations have genre X) is not, so it gets its own index.
  pgm.createIndex("station_genres", "genre_id");

  pgm.createTable("station_languages", {
    station_id: {
      type: "integer",
      notNull: true,
      references: "radio_stations",
      onDelete: "CASCADE",
    },
    language_id: {
      type: "integer",
      notNull: true,
      references: "languages",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("station_languages", "station_languages_pkey", {
    primaryKey: ["station_id", "language_id"],
  });
  pgm.createIndex("station_languages", "language_id");
};

exports.down = (pgm) => {
  pgm.dropTable("station_languages");
  pgm.dropTable("station_genres");
  pgm.dropTable("languages");
  pgm.dropTable("genres");
};
