/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Backfills the column the previous migration added, then locks it down
// (NOT NULL + a partial UNIQUE index) now that every row genuinely has a
// value. Runs only after the previous migration's addColumn has actually
// flushed - see that migration's comment for why the two steps can't be
// combined into one.
//
// A *partial* unique index - not a plain UNIQUE constraint on the whole
// table - deliberately excludes rejected events: a submission an admin
// already rejected must never permanently block a legitimate resubmission
// (corrected details, or simply resubmitted by someone else) from using
// the same title/time. It's still exact-match, not fuzzy: this catches an
// accidental double-submission (the same title, hand-typed or copy-pasted
// twice, for the exact same country and start time) the same conservative,
// deterministic way Step 16 catches a near-duplicate stream URL - it
// deliberately does *not* attempt a fuzzy time-window match (e.g. "within
// 2 hours"), since that would risk false positives between two genuinely
// different events that happen to share a title, which an exact-timestamp
// match cannot.
exports.up = async (pgm) => {
  // Deliberately a small, self-contained copy of the normalization
  // eventsRepository.ts's own normalizeEventTitle applies, rather than an
  // import from it - migrations are a frozen historical record and must
  // keep producing the exact same result they did the day they ran, even
  // if the application's own normalization logic is refined later.
  const { rows } = await pgm.db.query("SELECT id, title FROM events");
  for (const row of rows) {
    const normalized = row.title.trim().toLowerCase().replace(/\s+/g, " ");
    await pgm.db.query("UPDATE events SET title_normalized = $1 WHERE id = $2", [
      normalized,
      row.id,
    ]);
  }

  pgm.alterColumn("events", "title_normalized", { notNull: true });
  pgm.createIndex("events", ["country_id", "title_normalized", "starts_at"], {
    unique: true,
    where: "status <> 'rejected'",
    name: "events_country_title_starts_at_unique",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("events", ["country_id", "title_normalized", "starts_at"], {
    name: "events_country_title_starts_at_unique",
  });
  pgm.alterColumn("events", "title_normalized", { notNull: false });
};
