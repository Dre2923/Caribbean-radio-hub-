/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 62 (Background Update Workers, part two): the Advertising
// performance rollup. docs/ARCHITECTURE_PLAN.md names this the second
// real candidate job for this step, now that Step 57's ad_events exists to
// aggregate. This is deliberately NOT a replacement for GET
// /v1/admin/ads/reports (Step 57) - that endpoint already answers "give me
// real-time totals over any date range" directly from ad_events, correctly
// and without this table. This table's own, different value: a
// precomputed one-row-per-placement-per-day snapshot that (a) stays cheap
// to query as ad_events grows unboundedly over months/years of raw
// impression/click rows, and (b) remains a stable historical record even
// if a future step ever prunes/archives old raw events - the same
// "keep a durable summary, not just the raw log" reasoning real ad/
// analytics platforms use daily/hourly rollup tables for.
//
// One row per (placement_id, date) that actually had at least one event -
// not one row per placement per day regardless of activity. A zero-filled
// row for every placement on every day would grow with the size of the
// catalog (placement count x calendar days) independent of real ad
// traffic, the opposite of what a rollup table is for; a placement/date
// combination with no row here simply means zero impressions and zero
// clicks that day, the same "absence means zero" contract already
// documented on this table's own read path
// (repositories/adPerformanceRepository.ts).
//
// placement_id CASCADEs - the identical "a reporting child table cascades
// with its parent" reasoning ad_events' own migration already applied to
// itself (and, before that, station_health_checks, Step 19): a rollup row
// for a placement that no longer exists reports nothing anyone can act on.
exports.up = (pgm) => {
  pgm.createTable("ad_performance_daily", {
    id: "id",
    placement_id: {
      type: "integer",
      notNull: true,
      references: "ad_placements",
      onDelete: "CASCADE",
    },
    date: {
      type: "date",
      notNull: true,
    },
    impressions: {
      type: "integer",
      notNull: true,
      default: 0,
    },
    clicks: {
      type: "integer",
      notNull: true,
      default: 0,
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // The rollup worker's own write pattern (ON CONFLICT (placement_id,
  // date) DO UPDATE, an idempotent re-run for the same day never creates a
  // duplicate) needs this as a real unique constraint, not just an index -
  // the same "the upsert's own ON CONFLICT target must be a genuine
  // constraint" requirement Step 56's ad_placements uniqueness already
  // relies on.
  pgm.addConstraint("ad_performance_daily", "ad_performance_daily_placement_date_unique", {
    unique: ["placement_id", "date"],
  });

  // The listing endpoint's own access pattern (GET /v1/admin/ads/
  // performance-daily): every row for a placement across a date range, or
  // every placement's rows for a date range - indexed from day one, the
  // identical reasoning already applied to ad_events' own
  // (placement_id, created_at) index.
  pgm.createIndex("ad_performance_daily", ["placement_id", "date"]);
  pgm.createIndex("ad_performance_daily", ["date"]);
};

exports.down = (pgm) => {
  pgm.dropTable("ad_performance_daily");
};
