/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 24: the first step of the Events Database bucket (Steps 24-30), and
// the foundational table everything else in it builds on - the same shape
// Step 12 played for the Radio Master Catalog. Events differ from radio
// stations in one fundamental way that shapes this table from the start:
// any authenticated user can submit one (not just an admin), so a
// submission needs a real moderation lifecycle, not just an isActive
// on/off switch. `status` starts 'pending' for a regular user's own
// submission and is set straight to 'approved' for one an admin creates
// (an admin doesn't need to self-moderate, the same trust level every
// other admin-gated write in this API already has) - see
// src/routes/events.ts for exactly where that decision is made.
exports.up = (pgm) => {
  pgm.createTable("events", {
    id: "id",
    country_id: {
      type: "integer",
      notNull: true,
      references: "countries",
    },
    title: { type: "varchar(200)", notNull: true },
    description: { type: "text" },
    venue: { type: "varchar(300)" },
    starts_at: { type: "timestamptz", notNull: true },
    ends_at: { type: "timestamptz" },
    // HTTPS-validated at the application layer (schemas/events.ts), same
    // as radio_stations.logo_url - a flyer/promotional image, not
    // required, since not every event has one ready at submission time.
    image_url: { type: "text" },
    // An external link to buy tickets/RSVP - never handled by this API
    // itself (no payment processing here), matching the Project
    // Standard's "connect directly, don't intermediate" philosophy already
    // applied to radio_stations.stream_url.
    ticket_url: { type: "text" },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "pending",
      check: "status IN ('pending', 'approved', 'rejected')",
    },
    // Audit trail: who submitted this. Nullable and SET NULL on the
    // account's deletion (same reasoning as radio_stations.created_by_user_id
    // and users.country_id before it) - losing the submitter's account must
    // never cascade into losing the event itself.
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

  // NULL ends_at (an event with no announced end time) always satisfies a
  // CHECK - Postgres treats a NULL comparison as unknown, which a CHECK
  // constraint accepts - so this only ever actually enforces ordering once
  // both timestamps are known.
  pgm.addConstraint("events", "events_ends_at_after_starts_at", {
    check: '"ends_at" IS NULL OR "ends_at" > "starts_at"',
  });

  // The public read path always filters by country and always restricts to
  // status = 'approved'; the admin moderation queue filters by status
  // alone just as often - indexed for both from day one, the identical
  // reasoning already applied to radio_stations.country_id/is_active in
  // Step 12.
  pgm.createIndex("events", "country_id");
  pgm.createIndex("events", "status");
};

exports.down = (pgm) => {
  pgm.dropTable("events");
};
