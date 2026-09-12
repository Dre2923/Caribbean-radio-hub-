/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Step 53 (User Features, part three): the device push-token registry.
// Per docs/ARCHITECTURE_PLAN.md's sourced research, the standard, secure
// push-notification architecture is client -> backend -> FCM HTTP v1 API
// -> device, with the real service-account credential living only on the
// server (never the client) and a device-token registry on the backend
// that overwrites on every client-reported refresh, since FCM tokens
// rotate on reinstall/restore. This table, and the registration API built
// on top of it (routes/pushTokens.ts), is that registry.
//
// A plain table with a UNIQUE constraint on token, not a junction table
// like Step 51's favorites: a physical device's FCM token identifies a
// specific app installation, which belongs to exactly one account's
// session at a time (never two users simultaneously) - so a duplicate
// registration of the same token is a re-registration (the client's own
// refresh, or a different account logging in on the same device) that
// should overwrite the existing row's user_id/platform, never create a
// second row.
//
// user_id is ON DELETE CASCADE - deleting an account should remove its
// registered devices along with everything else it owns, the same
// posture as every other per-user table in this build.
//
// platform is a DB CHECK-constrained enum ('android'/'ios'/'windows') -
// the exact three mobile/desktop platforms the Project Standard's own
// Multi-platform-readiness Cross-Cutting Non-Negotiable names (macOS
// deferred).
//
// Deferred schema-DSL calls only (createTable, no pgm.db.query) - not
// subject to the deferred-DDL-vs-immediate-query hazard.
exports.up = (pgm) => {
  pgm.createTable("push_tokens", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    token: {
      type: "text",
      notNull: true,
      unique: true,
    },
    platform: {
      type: "text",
      notNull: true,
      check: "platform IN ('android', 'ios', 'windows')",
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
};

exports.down = (pgm) => {
  pgm.dropTable("push_tokens");
};
