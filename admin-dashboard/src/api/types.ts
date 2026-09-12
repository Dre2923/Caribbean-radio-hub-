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

// Mirrors backend/src/schemas/common.ts's countrySchema/genreSchema/
// languageSchema and schemas/stations.ts's stationSchema.
export interface Country {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Language {
  id: number;
  code: string;
  name: string;
}

export interface Station {
  id: number;
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  deactivatedByUserId: number | null;
  deactivationReason: string | null;
  genres: Genre[];
  languages: Language[];
  createdAt: string;
  updatedAt: string;
}
