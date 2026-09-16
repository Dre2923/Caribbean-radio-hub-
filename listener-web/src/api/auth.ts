import { apiFetch } from "./client";
import type { User } from "./types";

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  countryId?: number;
}

export function register(input: RegisterInput): Promise<{ user: User }> {
  return apiFetch("/v1/users", { method: "POST", body: input });
}

export interface LoginResponse {
  token: string;
  user: User;
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return apiFetch("/v1/auth/login", { method: "POST", body: { email, password } });
}

export async function fetchCurrentUser(): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/v1/me");
  return user;
}

export function requestPasswordReset(email: string): Promise<{ status: string; message: string }> {
  return apiFetch("/v1/auth/password-reset/request", { method: "POST", body: { email } });
}

export function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  return apiFetch("/v1/auth/password-reset/confirm", {
    method: "POST",
    body: { token, newPassword },
  });
}

export interface UpdateProfileInput {
  email?: string;
  displayName?: string;
  countryId?: number | null;
  currentPassword?: string;
}

export async function updateProfile(input: UpdateProfileInput): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/v1/me", { method: "PATCH", body: input });
  return user;
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return apiFetch("/v1/me/password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
}

export function deleteAccount(password: string): Promise<void> {
  return apiFetch("/v1/me", { method: "DELETE", body: { password } });
}
