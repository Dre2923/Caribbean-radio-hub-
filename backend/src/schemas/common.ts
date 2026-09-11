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
  },
  required: ["id", "email", "displayName", "countryId", "createdAt"],
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
