/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Launch countries, kept database-driven so more can be added later
// without a rebuild or code change.
const LAUNCH_COUNTRIES = [
  { code: "JM", name: "Jamaica" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "DM", name: "Dominica" },
  { code: "LC", name: "Saint Lucia" },
  { code: "GD", name: "Grenada" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "BB", name: "Barbados" },
  { code: "PR", name: "Puerto Rico" },
  { code: "VC", name: "Saint Vincent & the Grenadines" },
  { code: "KN", name: "Saint Kitts & Nevis" },
  { code: "AI", name: "Anguilla" },
  { code: "TC", name: "Turks and Caicos" },
  { code: "BS", name: "Bahamas" },
];

exports.up = (pgm) => {
  pgm.createTable("countries", {
    id: "id",
    code: { type: "varchar(2)", notNull: true, unique: true },
    name: { type: "varchar(120)", notNull: true },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  for (const country of LAUNCH_COUNTRIES) {
    pgm.sql(
      `INSERT INTO countries (code, name) VALUES ('${country.code}', '${country.name.replace(/'/g, "''")}')`,
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable("countries");
};
