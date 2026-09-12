import { apiFetch } from "./client";
import type { Event, EventStatus, Pagination } from "./types";

export interface ListEventsParams {
  countryId?: number;
  categoryId?: number;
  q?: string;
  status?: EventStatus;
  upcomingOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListEventsResponse {
  events: Event[];
  pagination: Pagination;
}

export async function listAdminEvents(params: ListEventsParams): Promise<ListEventsResponse> {
  const search = new URLSearchParams();
  if (params.countryId !== undefined) search.set("countryId", String(params.countryId));
  if (params.categoryId !== undefined) search.set("categoryId", String(params.categoryId));
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.upcomingOnly !== undefined) search.set("upcomingOnly", String(params.upcomingOnly));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  return apiFetch<ListEventsResponse>(`/v1/admin/events${qs ? `?${qs}` : ""}`);
}

export interface ModerateEventParams {
  id: number;
  status: "approved" | "rejected";
  // Only meaningful together with a status change - see
  // backend/README.md's "Events" section.
  moderationReason?: string;
}

export async function moderateEvent(params: ModerateEventParams): Promise<Event> {
  const { event } = await apiFetch<{ event: Event }>(`/v1/events/${params.id}`, {
    method: "PATCH",
    body: {
      status: params.status,
      ...(params.moderationReason ? { moderationReason: params.moderationReason } : {}),
    },
  });
  return event;
}

export async function deleteEvent(id: number): Promise<void> {
  await apiFetch<void>(`/v1/events/${id}`, { method: "DELETE" });
}
