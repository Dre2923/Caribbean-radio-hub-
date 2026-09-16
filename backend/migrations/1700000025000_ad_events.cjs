/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 57 (Advertising, part two): first-party placement-level reporting.
// Per docs/ARCHITECTURE_PLAN.md's own scoped research, a mediation SDK's
// own dashboard doesn't give a Caribbean-specific (per-country) view of
// how a placement performs - this table is exactly that, and only that:
// a plain event log a client reports to after the mediation SDK itself
// has already shown an ad or registered a click, never a replacement for
// the SDK's own impression/click tracking or payment reconciliation
// (Step 56's own README section already establishes that boundary).
//
// No user_id: most of this app's ad-eligible screens (the station
// catalog, the events list) are public and require no login at all, so
// most impressions this table will ever record come from anonymous
// listeners - there is no persistent identity to attach here even if a
// future step wanted one, and per-user ad analytics was never part of
// this step's scope. country_id is nullable and SET NULL (not CASCADE)
// on the country's own deletion - the same "a historical record stays
// true even if what it references is later removed" reasoning already
// applied to radio_stations.created_by_user_id and
// listening_history.station_id, since a real impression that already
// happened for a given country shouldn't be silently erased just because
// that country is later deregistered.
//
// placement_id IS CASCADE, not SET NULL, unlike country_id above - the
// deliberate difference reasoned explicitly: this table's entire
// reporting shape (GET /v1/admin/ads/reports) is organized *by*
// placement, so an event with no placement to attribute it to serves no
// reporting purpose at all, the identical "a diagnostic/reporting child
// table cascades with its parent" precedent station_health_checks (Step
// 19) already established - unlike listening_history, whose subject is
// the user's own history, not the station.
exports.up = (pgm) => {
  pgm.createTable("ad_events", {
    id: "id",
    placement_id: {
      type: "integer",
      notNull: true,
      references: "ad_placements",
      onDelete: "CASCADE",
    },
    event_type: {
      type: "text",
      notNull: true,
      check: "event_type IN ('impression', 'click')",
    },
    country_id: {
      type: "integer",
      references: "countries",
      onDelete: "SET NULL",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // The reporting query's own access pattern: "every event for this
  // placement (optionally filtered by type/country/date range)" - indexed
  // from day one, the same reasoning already applied to
  // station_health_checks' (station_id, checked_at) index.
  pgm.createIndex("ad_events", ["placement_id", "created_at"]);
  pgm.createIndex("ad_events", ["country_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("ad_events");
};
