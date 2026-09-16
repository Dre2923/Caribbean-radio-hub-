// Thin fetch wrapper for this client's own API calls - the identical
// pattern admin-dashboard/src/api/client.ts already established.
//
// Phase 1 of this prototype had no auth state at all (every endpoint it
// touched was public). Phase 2 adds real authenticated endpoints
// (favorites, listening history, profile, voice, event submission), so
// this now carries a bearer token the same way admin-dashboard's client
// does - with one deliberate difference: admin-dashboard uses
// sessionStorage (an admin back-office, cleared on tab close, by design -
// see that file's own comment). This is a consumer app; a listener
// reasonably expects to stay signed in across closing a tab, the same way
// the real Flutter client would persist a session (docs/
// FLUTTER_CLIENT_SPEC.md Section 5). localStorage is used here instead -
// a deliberate, documented choice, not a copy-paste of the admin pattern.
// GET /v1/me still remains the real source of truth on every app load
// (see auth/AuthProvider.tsx) - a stored token is only ever provisionally
// trusted, exactly as admin-dashboard's own AuthProvider already models.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_STORAGE_KEY = "crh-listener-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Best-effort only, same posture as useCachedQuery's own storage
    // writes - a storage failure must never crash a login/logout action.
  }
}

interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

// A single global 401 handler, registered once by AuthProvider - per
// docs/FLUTTER_CLIENT_SPEC.md Section 9.2: "the only correct client
// behavior for any 401, anywhere in the app... applied globally via the
// ApiClient's single interceptor rather than re-implemented per screen."
// There is no refresh-token endpoint in this backend, so there is nothing
// to retry - every 401 means the stored token is gone/expired/invalidated.
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  // The backend's error envelope is always { status: "error", message } -
  // backend/src/schemas/common.ts's errorResponseSchema - so every
  // non-2xx response has a real, human-readable message to surface.
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.statusText || "Request failed";
    // Only fires for an authenticated call that already had a token
    // attached - an anonymous 401 (e.g. a signed-out user hitting a
    // gated endpoint on purpose) has nothing stored to clear.
    if (response.status === 401 && token) {
      unauthorizedHandler?.();
    }
    throw new ApiError(response.status, message);
  }

  return data as T;
}
