/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 27: moderation audit trail - the fourth step of the Events Database
// bucket, mirroring Step 17's radio_stations deactivation audit exactly,
// including the reasoning. Step 24's `status` column already lets an admin
// approve or reject a submission, but recorded nothing about *who* decided
// or *when* or *why* - an admin reviewing the moderation queue (or a future
// submitter wondering why their event was rejected) had no way to tell
// "an admin reviewed this and rejected it as spam" from "nobody has looked
// at this yet" without separately remembering or looking elsewhere.
//
// All three columns are nullable and only ever populated as a side effect
// of a status decision (see eventsRepository.ts) - never independently
// editable. This covers both paths a status is ever set from: an admin's
// own submission is auto-approved at creation (Step 24) - that auto-
// approval *is* the moderation decision, made by the same admin, so it's
// recorded there too, not left null just because it happened at creation
// time rather than a later PATCH; a regular user's submission starts
// unmoderated (all three null) until an admin's PATCH sets status, which
// records that PATCH's own actor/timestamp/reason.
//
// A single addColumn-only migration, not split in two: there is no
// backfill step here (an existing pre-this-migration row simply gets NULL
// across all three, which is the correct "never explicitly moderated"
// state for an already-approved-at-creation row), so there's no immediate
// pgm.db.query to order against the deferred pgm.addColumn call - the
// exact hazard documented in docs/BUILD_MANIFEST.md's Cross-Cutting
// Non-Negotiables simply doesn't arise here, the identical shape as Step
// 17's own migration.
exports.up = (pgm) => {
  pgm.addColumn("events", {
    moderated_at: { type: "timestamptz" },
    moderated_by_user_id: {
      type: "integer",
      references: "users",
      onDelete: "SET NULL",
    },
    moderation_reason: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("events", ["moderated_at", "moderated_by_user_id", "moderation_reason"]);
};
