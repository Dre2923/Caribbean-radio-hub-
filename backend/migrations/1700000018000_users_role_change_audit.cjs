/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 31 (Admin Dashboard): the first step of this bucket adds the one
// real gap found during the Steps 27-64 architecture research
// (docs/ARCHITECTURE_PLAN.md) - there is no admin-facing way to list users
// or change a role today, only the config-driven ADMIN_EMAILS bootstrap
// allowlist (Step 11). Before adding that endpoint, this migration adds
// the identical audit-trail shape already established for
// radio_stations.deactivated_at/by/reason (Step 17) and
// events.moderated_at/by/reason (Step 27): granting or revoking admin
// access is exactly the kind of sensitive action a real admin console
// audits, not silently overwrites.
//
// No moderation_reason-equivalent column here - a role change is a single
// enum flip with no analogous free-text justification field in the
// manifest's requirements, unlike a station being pulled from the catalog
// or an event being rejected. If a real operational need for one emerges
// later, it can be added the same additive way every other optional
// column in this build has been.
//
// Both columns are nullable and only ever populated as a side effect of
// an actual role change (see usersRepository.setUserRole) - never
// independently editable. role_changed_by_user_id stays NULL for the
// automated ADMIN_EMAILS bootstrap promotion (no human admin acted; the
// same "actorUserId: null means the system did this" convention already
// established for radio_stations.deactivated_by_user_id's Step 19-23
// automated-monitor case) while role_changed_at is still set, so an
// admin reviewing the list can tell "the system bootstrapped this account"
// from "another admin explicitly promoted it" without a separate flag.
//
// A single addColumn-only migration, not split in two: an existing row
// simply gets NULL across both, the correct "role was never explicitly
// changed after account creation" state - no backfill, so no
// deferred-DDL-vs-immediate-query ordering question to navigate.
exports.up = (pgm) => {
  pgm.addColumn("users", {
    role_changed_at: { type: "timestamptz" },
    role_changed_by_user_id: {
      type: "integer",
      references: "users",
      onDelete: "SET NULL",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", ["role_changed_at", "role_changed_by_user_id"]);
};
