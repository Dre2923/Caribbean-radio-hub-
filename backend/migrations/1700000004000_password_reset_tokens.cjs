/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Only a SHA-256 hash of the reset token is stored, never the token
// itself - the same reasoning as never storing a plaintext password,
// so a database leak alone can't be used to take over accounts via
// pending reset links. Unlike a password, a reset token is a 256-bit
// cryptographically random value (never user-chosen, never reused
// across sites), so a fast hash is the correct tool here - bcrypt's
// deliberate slowness defends against guessing a *low-entropy*
// user-chosen secret, which doesn't apply to a token nobody could
// feasibly guess.
exports.up = (pgm) => {
  pgm.createTable("password_reset_tokens", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    token_hash: { type: "char(64)", notNull: true, unique: true }, // hex SHA-256
    expires_at: { type: "timestamptz", notNull: true },
    used_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // Every password-reset confirm looks a token up by its hash; every
  // request for a new token invalidates a user's outstanding ones.
  pgm.createIndex("password_reset_tokens", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("password_reset_tokens");
};
