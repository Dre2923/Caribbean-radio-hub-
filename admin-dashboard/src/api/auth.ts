import { apiFetch } from "./client";
import type { AdminUser } from "./types";

export interface LoginResponse {
  token: string;
  user: AdminUser;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/v1/auth/login", { method: "POST", body: { email, password } });
}

export async function fetchCurrentUser(): Promise<AdminUser> {
  const { user } = await apiFetch<{ user: AdminUser }>("/v1/me");
  return user;
}
