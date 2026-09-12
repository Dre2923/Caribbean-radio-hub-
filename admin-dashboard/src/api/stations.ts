import { apiFetch } from "./client";
import type { Pagination, Station } from "./types";

export interface ListStationsParams {
  countryId?: number;
  genreId?: number;
  languageId?: number;
  q?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListStationsResponse {
  stations: Station[];
  pagination: Pagination;
}

export async function listAdminStations(params: ListStationsParams): Promise<ListStationsResponse> {
  const search = new URLSearchParams();
  if (params.countryId !== undefined) search.set("countryId", String(params.countryId));
  if (params.genreId !== undefined) search.set("genreId", String(params.genreId));
  if (params.languageId !== undefined) search.set("languageId", String(params.languageId));
  if (params.q) search.set("q", params.q);
  if (params.isActive !== undefined) search.set("isActive", String(params.isActive));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  return apiFetch<ListStationsResponse>(`/v1/admin/stations${qs ? `?${qs}` : ""}`);
}

export interface SetStationActiveParams {
  id: number;
  isActive: boolean;
  // Only meaningful together with isActive: false - see
  // backend/README.md's "Data quality" / "Curation" sections.
  deactivationReason?: string;
}

// PATCH/DELETE both live at /v1/stations/:id, not /v1/admin/stations/:id -
// "admin" only prefixes the full-visibility *listing* route (the one place
// an inactive station is visible at all); the mutations themselves are
// simply admin-gated, same path as everyone else's view of a single
// station (see backend/README.md's "Radio Master Catalog").
export async function setStationActive(params: SetStationActiveParams): Promise<Station> {
  const { station } = await apiFetch<{ station: Station }>(`/v1/stations/${params.id}`, {
    method: "PATCH",
    body: {
      isActive: params.isActive,
      ...(params.deactivationReason ? { deactivationReason: params.deactivationReason } : {}),
    },
  });
  return station;
}

export async function deleteStation(id: number): Promise<void> {
  await apiFetch<void>(`/v1/stations/${id}`, { method: "DELETE" });
}
