/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 56 (Advertising, part one): ad placement configuration. Per
// docs/ARCHITECTURE_PLAN.md's own sourced research, real mobile ad
// monetization runs through a client-side mediation SDK (e.g. AdMob) that
// itself connects to multiple ad networks/SSPs and handles actually
// serving creative, tracking impressions/clicks, and payment - building a
// custom ad-serving/tracking backend from scratch would be reinventing
// what a real ad network already does. This backend's honest, valuable
// scope is ad *configuration*: which ad unit/placement ids are active, per
// country and screen, so the mediation SDK on the client knows what to
// load and where - fully buildable and testable with zero ad network
// account, the same "backend-buildable without the blocked half" split
// already applied to Voice System's text-in/intent-out half and User
// Features' push-notification registry.
//
// placement_key is a stable identifier the client's own code references
// directly (e.g. "station_list_banner", "player_interstitial") - never
// renamed once shipped, since a client build hardcodes it.
//
// country_id is nullable, not a second junction table like Step 51's
// favorites: NULL means "the global default for this placement", a
// non-null value means "the override for that specific country" - the
// client always resolves a placement by preferring a country-specific row
// over the global one, never both at once. ON DELETE CASCADE mirrors every
// other country-scoped table in this build (radio_stations, events):
// deleting a country removes configuration scoped to it.
//
// ad_format is a DB CHECK-constrained enum matching AdMob's own
// documented ad formats (banner/interstitial/rewarded/native) - the same
// "text column + CHECK" convention already used for users.role and
// push_tokens.platform, chosen over a Postgres native ENUM type for the
// identical reason: adding a new format later is a plain CHECK-constraint
// migration, not an ALTER TYPE.
//
// android_ad_unit_id/ios_ad_unit_id are both nullable and platform-
// specific by design, not a single shared column: AdMob issues a distinct
// ad unit id per platform even for what a human calls "the same
// placement", since Android and iOS apps are registered as separate
// AdMob "apps" in its own console. A placement can be staged (created,
// not yet active) with neither id set while ad unit ids are still being
// requested from the ad network - the ad_placements_active_requires_ad_unit_id
// constraint below only requires at least one once is_active flips true,
// so an incomplete placement can never actually be served.
//
// Two uniqueness rules, not one plain UNIQUE(placement_key, country_id):
// Postgres treats every NULL as distinct from every other NULL, so a
// plain unique constraint on (placement_key, country_id) would silently
// allow multiple "global default" rows (country_id NULL) for the same
// placement_key - a real, well-known Postgres NULL-uniqueness gotcha, not
// a hypothetical one. The partial unique index below closes exactly that
// gap by treating every "country_id IS NULL" row as competing for the
// same slot, while the plain unique constraint still covers the
// non-null, per-country case normally.
exports.up = (pgm) => {
  pgm.createTable("ad_placements", {
    id: "id",
    placement_key: {
      type: "text",
      notNull: true,
    },
    country_id: {
      type: "integer",
      references: "countries",
      onDelete: "CASCADE",
    },
    ad_format: {
      type: "text",
      notNull: true,
      check: "ad_format IN ('banner', 'interstitial', 'rewarded', 'native')",
    },
    android_ad_unit_id: { type: "text" },
    ios_ad_unit_id: { type: "text" },
    is_active: {
      type: "boolean",
      notNull: true,
      default: false,
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

  pgm.addConstraint("ad_placements", "ad_placements_key_country_unique", {
    unique: ["placement_key", "country_id"],
  });
  pgm.createIndex("ad_placements", "placement_key", {
    unique: true,
    where: '"country_id" IS NULL',
    name: "ad_placements_global_key_unique",
  });
  pgm.addConstraint("ad_placements", "ad_placements_active_requires_ad_unit_id", {
    check:
      '(NOT "is_active") OR "android_ad_unit_id" IS NOT NULL OR "ios_ad_unit_id" IS NOT NULL',
  });
  pgm.createIndex("ad_placements", "country_id");
};

exports.down = (pgm) => {
  pgm.dropTable("ad_placements");
};
