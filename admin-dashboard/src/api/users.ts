import { apiFetch } from "./client";
import type { AdminUser, Pagination, UserRole } from "./types";

export interface ListUsersParams {
  q?: string;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

export interface ListUsersResponse {
  users: AdminUser[];
  pagination: Pagination;
}

export async function listUsers(params: ListUsersParams): Promise<ListUsersResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.role) search.set("role", params.role);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  return apiFetch<ListUsersResponse>(`/v1/admin/users${qs ? `?${qs}` : ""}`);
}

export async function updateUserRole(id: number, role: UserRole): Promise<AdminUser> {
  const { user } = await apiFetch<{ user: AdminUser }>(`/v1/admin/users/${id}`, {
    method: "PATCH",
    body: { role },
  });
  return user;
}
