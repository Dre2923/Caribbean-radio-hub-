import { apiFetch } from "./client";
import type { Event, Pagination } from "./types";

export interface ListEventsParams {
  countryId?: number;
  categoryId?: number;
  q?: string;
  startsAfter?: string;
  startsBefore?: string;
  includePast?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListEventsResponse {
  events: Event[];
  pagination: Pagination;
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value as string | number | boolean));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// GET /v1/events already excludes concluded events and orders
// soonest-first by default (backend/src/routes/events.ts) - this client
// applies no additional filtering or re-sorting on top of what the
// backend already does, per docs/FLUTTER_CLIENT_SPEC.md Section 6.3's
// own "the client applies no additional sort" note.
export function listEvents(params: ListEventsParams): Promise<ListEventsResponse> {
  return apiFetch(`/v1/events${buildQuery(params)}`);
}

export function getEvent(id: number): Promise<{ event: Event }> {
  return apiFetch(`/v1/events/${id}`);
}

export interface SubmitEventInput {
  countryId: number;
  title: string;
  description?: string;
  venue?: string;
  venueAddress?: string;
  latitude?: number;
  longitude?: number;
  startsAt: string;
  endsAt?: string;
  imageUrl?: string;
  ticketUrl?: string;
  categoryIds?: number[];
}

// POST /v1/events requires only authentication (not admin) - any signed-in
// user can submit an event, which starts in the moderation queue
// (status: "pending") until an admin approves it. See
// backend/src/routes/events.ts's own createEventHandler comment.
export async function submitEvent(input: SubmitEventInput): Promise<Event> {
  const { event } = await apiFetch<{ event: Event }>("/v1/events", { method: "POST", body: input });
  return event;
}
