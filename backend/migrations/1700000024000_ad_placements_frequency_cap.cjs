/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 57 (Advertising, part two): frequency capping rules. Per
// docs/ARCHITECTURE_PLAN.md's own scoped research, this backend's honest
// role in advertising is configuration, not ad serving - real ad
// mediation SDKs (AdMob and equivalents) already frequency-cap on-device,
// since that's the only place a specific device's own impression count
// can actually be tracked (this backend has no persistent device
// identity for an anonymous, unauthenticated listener browsing the
// public catalog - most of this app's ad-eligible screens require no
// login at all). What the backend can and should own is the *rule
// itself*: how many times a placement is allowed to show per period,
// configured centrally so every client enforces the identical policy
// rather than each guessing its own, surfaced to the client via
// GET /v1/ads/config alongside the ad unit ids it already returns.
//
// A separate addColumn+addConstraint migration on the existing
// ad_placements table (Step 56), not a rewrite of that migration - the
// identical "the closing step adds a column via its own migration"
// discipline already established for radio_stations across Steps 11/17/18.
//
// Both columns null together (no cap configured - the common case) or
// both set together (a real cap) - a lone max_impressions_per_period with
// no period, or vice versa, is meaningless and would silently corrupt
// client-side enforcement, the same "both or neither" reasoning already
// applied to events.latitude/longitude (Step 30).
exports.up = (pgm) => {
  pgm.addColumn("ad_placements", {
    max_impressions_per_period: { type: "integer" },
    frequency_cap_period: {
      type: "text",
      check: "frequency_cap_period IN ('session', 'day')",
    },
  });

  pgm.addConstraint("ad_placements", "ad_placements_frequency_cap_together", {
    check:
      '("max_impressions_per_period" IS NULL) = ("frequency_cap_period" IS NULL)',
  });
  pgm.addConstraint("ad_placements", "ad_placements_frequency_cap_positive", {
    check: '"max_impressions_per_period" IS NULL OR "max_impressions_per_period" > 0',
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("ad_placements", "ad_placements_frequency_cap_positive");
  pgm.dropConstraint("ad_placements", "ad_placements_frequency_cap_together");
  pgm.dropColumn("ad_placements", ["max_impressions_per_period", "frequency_cap_period"]);
};
