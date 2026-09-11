/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// JWTs are stateless: verifying a signature says nothing about whether the
// password has changed since the token was issued. Without this, a stolen
// token stays fully valid for its whole lifetime even after the account
// owner changes their password specifically to shut that access down.
// Bumping this on every password change and embedding it in the token at
// login lets app.authenticate reject a token minted before the most recent
// password change, while a mismatch-free check stays cheap (an integer
// compare, not a second credential check).
exports.up = (pgm) => {
  pgm.addColumn("users", {
    token_version: { type: "integer", notNull: true, default: 0 },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "token_version");
};
