import { apiFetch } from "./client";
import type { Pagination, RankedStation, Station } from "./types";

export interface ListStationsParams {
  countryId?: number;
  genreId?: number;
  languageId?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListStationsResponse {
  stations: Station[];
  pagination: Pagination;
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value as string | number));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function listStations(params: ListStationsParams): Promise<ListStationsResponse> {
  return apiFetch(`/v1/stations${buildQuery(params)}`);
}

export function getStation(id: number): Promise<{ station: Station }> {
  return apiFetch(`/v1/stations/${id}`);
}

export interface RankedStationsParams {
  countryId: number;
  windowHours?: number;
  limit?: number;
}

// GET /v1/stations/ranked - the fallback-chain entry point. Public route
// docs (backend/src/routes/stationRanking.ts) describe the contract
// verbatim: "a client should try stations[0], and fall through to the
// next entry if it fails to play" - exactly what
// hooks/usePlayer.ts implements client-side.
export function listRankedStations(params: RankedStationsParams): Promise<{ stations: RankedStation[] }> {
  return apiFetch(`/v1/stations/ranked${buildQuery(params)}`);
}
