// Admin user-management (Step 31) schema fragments, kept in their own
// module the same way schemas/stations.ts/schemas/events.ts separated out
// from schemas/common.ts once their domain needed more than the shared
// userSchema.

// Matches MAX_EMAIL_LENGTH (254, RFC 5321) - the longer of the two fields
// GET /v1/admin/users?q= searches (email, displayName), so a search term
// can never usefully exceed it.
export const MAX_USER_SEARCH_LENGTH = 254;

export const USER_ROLES = ["user", "admin"] as const;
