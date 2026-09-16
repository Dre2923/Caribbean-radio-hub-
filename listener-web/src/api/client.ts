// Thin fetch wrapper for this client's own API calls - the identical
// pattern admin-dashboard/src/api/client.ts already established, minus
// the token-header logic that pattern needs and this one doesn't: every
// endpoint this listener client calls is public (see PROTOTYPE_PLAN.md's
// "Features included" for the exact list), so there is no auth state to
// attach here at all.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");

  const response = await fetch(path, { ...init, headers });

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
    throw new ApiError(response.status, message);
  }

  return data as T;
}
