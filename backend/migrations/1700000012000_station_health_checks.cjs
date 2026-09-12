/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 19: the first step of the Stream Reliability bucket (Steps 19-23),
// and the foundational table the per-country quality ranking (see
// docs/BUILD_MANIFEST.md's "Radio Station Quality Ranking") builds on -
// that ranking needs a real, measured history of each station's actual
// streaming reliability, not an assumption. Each row is one point-in-time
// reachability check against a station's own stream_url (never against a
// proxy or cached copy - the Project Standard's no-rebroadcast rule
// applies here too: this only ever probes the station's own authorized
// endpoint the same way a listener's device would connect to it).
exports.up = (pgm) => {
  pgm.createTable("station_health_checks", {
    id: "id",
    station_id: {
      type: "integer",
      notNull: true,
      references: "radio_stations",
      onDelete: "CASCADE",
    },
    checked_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    is_reachable: { type: "boolean", notNull: true },
    status_code: { type: "integer" },
    latency_ms: { type: "integer", notNull: true },
    error: { type: "text" },
  });

  // Every future consumer of this table (the ranking computation in a
  // later step, an admin history view, a retention/cleanup job) queries
  // "this station's checks, most recent first" - indexed for that access
  // pattern from day one rather than after the table is large enough to
  // make a sequential scan noticeable, the same reasoning already applied
  // to radio_stations.country_id/is_active in Step 12.
  pgm.createIndex("station_health_checks", ["station_id", "checked_at"]);
};

exports.down = (pgm) => {
  pgm.dropTable("station_health_checks");
};
