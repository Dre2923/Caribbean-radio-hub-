/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Foundation for admin-gated endpoints the rest of the build will need
// (Radio Catalog curation, Events moderation, the Admin Dashboard itself at
// Steps 31-33) - added now, before any of those exist, rather than
// retrofitting an authorization model onto live data later. Every account
// starts as 'user'; promotion to 'admin' happens only through the
// ADMIN_EMAILS bootstrap (see src/repositories/usersRepository.ts
// ensureBootstrapAdminRole) or a future admin-management flow - never a
// client-settable field on registration/profile-update.
exports.up = (pgm) => {
  pgm.addColumn("users", {
    role: {
      type: "varchar(20)",
      notNull: true,
      default: "user",
      check: "role IN ('user', 'admin')",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "role");
};
