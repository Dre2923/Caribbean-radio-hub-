// Shared JSON Schema fragments reused across route schemas and surfaced in
// the generated OpenAPI docs (see app.ts). Keeping them in one place means
// the "shape of a user" or "shape of an error" is defined once, not
// re-typed slightly differently in every route file.

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
