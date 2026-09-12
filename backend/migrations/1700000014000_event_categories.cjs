/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 25: event metadata taxonomy, the first step of continuing the
// Events Database bucket past Step 24's core/moderation foundation -
// mirrors Step 13's genres/languages for the Radio Master Catalog
// exactly, including the reasoning. A database-driven lookup table (seed
// a starter set, add more later without a code change), not a hardcoded
// enum, since the actual mix of event types this platform hosts
// (Carnival, festivals, concerts, community gatherings...) is exactly the
// kind of thing curators will keep expanding.
//
// An event is rarely "only" one category (a Carnival event is often also
// a Concert, a Festival often also Food & Drink), so this is a
// many-to-many junction table, not a column on events itself - the
// identical shape as station_genres/station_languages.
//
// Seed data lives in the next migration, not here - pgm.createTable/
// addConstraint/createIndex only queue SQL that flushes after this
// function returns, so an immediate pgm.db.query seed insert in the same
// migration would run before these tables actually exist (the same
// deferred-DDL-vs-immediate-query hazard already hit and fixed for
// countries, and checked for explicitly on every migration since).
exports.up = (pgm) => {
  pgm.createTable("event_categories", {
    id: "id",
    name: { type: "varchar(60)", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // Composite primary key, not a surrogate id - the pair is the whole
  // fact ("this event has this category"), and it also doubles as the
  // uniqueness constraint that stops the same category being attached to
  // an event twice. CASCADE on both sides: deleting an event should drop
  // its category associations along with it, and (though categories have
  // no delete path yet) so should retiring a category.
  pgm.createTable("event_category_assignments", {
    event_id: {
      type: "integer",
      notNull: true,
      references: "events",
      onDelete: "CASCADE",
    },
    category_id: {
      type: "integer",
      notNull: true,
      references: "event_categories",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("event_category_assignments", "event_category_assignments_pkey", {
    primaryKey: ["event_id", "category_id"],
  });
  // The event->categories direction (used on every event read) is covered
  // by the primary key's leading column; the reverse direction (which
  // events have category X, what GET /v1/events?categoryId= filters on)
  // is not, so it gets its own index.
  pgm.createIndex("event_category_assignments", "category_id");
};

exports.down = (pgm) => {
  pgm.dropTable("event_category_assignments");
  pgm.dropTable("event_categories");
};
