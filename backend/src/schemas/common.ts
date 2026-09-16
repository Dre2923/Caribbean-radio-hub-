// Shared JSON Schema fragments reused across route schemas and surfaced in
// the generated OpenAPI docs (see app.ts). Keeping them in one place means
// the "shape of a user" or "shape of an error" is defined once, not
// re-typed slightly differently in every route file.

// Step 55/User Features bucket closing adversarial pass: every id-shaped
// integer field across this API (a station/event/country/genre/language/
// category id, in a path param, body field, querystring filter, or id-list
// array) is ultimately compared against a Postgres `integer` (int4) column
// - `serial` primary keys and their foreign-key references are int4 by
// default, confirmed directly against every `CREATE TABLE` in this
// project's own migrations. int4's documented range
// (postgresql.org/docs/current/datatype-numeric.html) is exactly
// -2147483648 to 2147483647. Before this fix, every one of those fields
// only enforced `minimum: 1` with no upper bound, so a client-supplied id
// like 99999999999999999999 passed AJV's own `type: "integer"` check (very
// large whole numbers are still integers in IEEE-754 double precision, the
// same representation JavaScript's `Number` type uses) and reached the
// repository layer, where Postgres itself rejected it with a raw
// "value ... out of range for type integer" error - an unhandled 500, not
// the clean 400 a malformed id should produce. Reproduced live against a
// running compiled server before writing this fix, not assumed.
export const POSTGRES_INTEGER_MAX = 2147483647;

// The one shared schema every id-shaped integer field in this API should
// use instead of a bespoke, unbounded `{ type: "integer", minimum: 1 }` -
// defined once here so every call site gets the upper bound for free and a
// future id field can't reintroduce the same gap by copying an old,
// unbounded inline schema instead of this one.
export const idSchema = {
  type: "integer",
  minimum: 1,
  maximum: POSTGRES_INTEGER_MAX,
} as const;

// The nullable variant, for a field where `null` itself is meaningful
// (e.g. ad_placements.country_id's "no country override, this is the
// global default" - schemas/ads.ts) rather than merely optional. Carries
// the exact same bounds as idSchema for the non-null case - `minimum`/
// `maximum` are simply not evaluated against a `null` instance under
// JSON Schema's own semantics, so this never weakens the int4 bound
// idSchema exists to enforce.
export const nullableIdSchema = {
  type: ["integer", "null"],
  minimum: 1,
  maximum: POSTGRES_INTEGER_MAX,
} as const;

export const errorResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["error"] },
    message: { type: "string" },
  },
  required: ["status", "message"],
} as const;

export const userSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    email: { type: "string", format: "email" },
    displayName: { type: "string" },
    countryId: { type: ["integer", "null"] },
    createdAt: { type: "string", format: "date-time" },
    // Never client-settable - see usersRepository.ts ensureBootstrapAdminRole
    // and PATCH /v1/admin/users/:id for the only two ways this changes.
    // Surfaced here so a client can conditionally show admin-only UI
    // without a separate lookup.
    role: { type: "string", enum: ["user", "admin"] },
    // Step 31: only non-null once this account's role has actually
    // changed from its created default - see usersRepository.ts's User
    // interface for the full null-means-what breakdown.
    roleChangedAt: { type: ["string", "null"], format: "date-time" },
    roleChangedByUserId: { type: ["integer", "null"] },
  },
  required: [
    "id",
    "email",
    "displayName",
    "countryId",
    "createdAt",
    "role",
    "roleChangedAt",
    "roleChangedByUserId",
  ],
} as const;

export const countrySchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    code: { type: "string" },
    name: { type: "string" },
    isActive: { type: "boolean" },
  },
  required: ["id", "code", "name", "isActive"],
} as const;

export const genreSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
  required: ["id", "name"],
} as const;

export const languageSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    code: { type: "string" },
    name: { type: "string" },
  },
  required: ["id", "code", "name"],
} as const;

export const eventCategorySchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
  required: ["id", "name"],
} as const;
