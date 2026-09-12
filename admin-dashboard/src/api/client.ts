// Thin fetch wrapper shared by every api/* module. Same-origin `/v1/...`
// paths only - see vite.config.ts's dev-server proxy and README.md's
// production reverse-proxy note for why the dashboard never hardcodes a
// backend host.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_STORAGE_KEY = "caribbean-admin-token";

// sessionStorage, not localStorage: this token can change a user's role,
// including granting admin access - a deliberately session-scoped (cleared
// on tab close), not "remembered forever," choice for a console this
// sensitive, the same reasoning a bank's or a cloud provider's admin
// back-office typically applies. Documented explicitly rather than
// defaulted to unthinkingly: the server-side JWT itself still lives for the
// full JWT_EXPIRES_IN (backend/README.md), this only controls how long the
// *browser tab* keeps hold of it.
export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null): void {
  if (token) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
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
  // see backend/src/schemas/common.ts's errorResponseSchema - so every
  // non-2xx response has a real, human-readable message to surface, not
  // just a bare status code.
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.statusText || "Request failed";
    throw new ApiError(response.status, message);
  }

  return data as T;
}
