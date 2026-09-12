// Mirrors backend/src/schemas/common.ts's userSchema exactly - this is a
// consumer of that contract, not an independent source of truth for it. If
// the backend's shape changes, this must change with it (there's no
// runtime validation on the dashboard side; the backend's own JSON Schema
// response validation is the actual guarantee these fields are always
// present).
export type UserRole = "user" | "admin";

export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  countryId: number | null;
  createdAt: string;
  role: UserRole;
  roleChangedAt: string | null;
  roleChangedByUserId: number | null;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}
