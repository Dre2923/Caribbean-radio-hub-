/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Backfills the column the previous migration added, then locks it down
// (NOT NULL + UNIQUE) now that every row genuinely has a value. Runs only
// after the previous migration's addColumn has actually flushed - see that
// migration's comment for why the two steps can't be combined into one.
exports.up = async (pgm) => {
  // Deliberately a small, self-contained copy of
  // src/utils/streamUrlValidation.ts's normalizeStreamUrl rather than an
  // import from it - migrations are a frozen historical record and must
  // keep producing the exact same result they did the day they ran, even
  // if the application's own normalization logic is refined later.
  const { rows } = await pgm.db.query("SELECT id, stream_url FROM radio_stations");
  for (const row of rows) {
    const url = new URL(row.stream_url);
    const scheme = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const port = url.port && url.port !== "443" ? `:${url.port}` : "";
    const path = url.pathname === "/" ? "" : url.pathname;
    const normalized = `${scheme}//${host}${port}${path}${url.search}`;
    await pgm.db.query("UPDATE radio_stations SET stream_url_normalized = $1 WHERE id = $2", [
      normalized,
      row.id,
    ]);
  }

  pgm.alterColumn("radio_stations", "stream_url_normalized", { notNull: true });
  pgm.addConstraint("radio_stations", "radio_stations_stream_url_normalized_key", {
    unique: "stream_url_normalized",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("radio_stations", "radio_stations_stream_url_normalized_key");
  pgm.alterColumn("radio_stations", "stream_url_normalized", { notNull: false });
};
