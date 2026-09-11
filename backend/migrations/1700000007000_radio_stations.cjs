/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 12: the Caribbean Radio Master Catalog's core table. Per the
// Project Standard, this only ever stores metadata about a station and its
// own authorized stream URL - the app connects a listener's device
// directly to that URL and never proxies, records, or rebroadcasts the
// audio itself, so there is deliberately no audio-storage column here.
exports.up = (pgm) => {
  pgm.createTable("radio_stations", {
    id: "id",
    country_id: {
      type: "integer",
      notNull: true,
      references: "countries",
    },
    name: { type: "varchar(200)", notNull: true },
    // Unique at the database level, not just checked in application code -
    // the exact duplicate-prevention Step 16 (data quality) will build on,
    // guaranteed from the moment this table exists rather than deferred.
    stream_url: { type: "text", notNull: true, unique: true },
    website_url: { type: "text" },
    description: { type: "text" },
    // Soft-disable, not a delete: curation (Step 17) needs to pull a
    // station from public listings (a stream went dead, a station asked to
    // be removed) without losing its history - the same pattern already
    // used for countries.is_active.
    is_active: { type: "boolean", notNull: true, default: true },
    // Audit trail: which admin account added this entry. Nullable and
    // SET NULL on the account's deletion (same reasoning as
    // users.country_id) - losing the admin account must never cascade into
    // losing the station data attributed to them.
    created_by_user_id: {
      type: "integer",
      references: "users",
      onDelete: "SET NULL",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // The public catalog's read path always filters/groups by country, and
  // very commonly restricts to active-only - indexed for both from day one
  // rather than after the catalog is large enough to make sequential scans
  // noticeable.
  pgm.createIndex("radio_stations", "country_id");
  pgm.createIndex("radio_stations", "is_active");
};

exports.down = (pgm) => {
  pgm.dropTable("radio_stations");
};
