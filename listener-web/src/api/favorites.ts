import { apiFetch } from "./client";
import type { FavoriteEvent, FavoriteStation, Pagination } from "./types";

export async function listFavoriteStations(): Promise<{ favorites: FavoriteStation[]; pagination: Pagination }> {
  return apiFetch("/v1/me/favorites/stations");
}

export function favoriteStation(stationId: number): Promise<void> {
  return apiFetch(`/v1/me/favorites/stations/${stationId}`, { method: "PUT" });
}

export function unfavoriteStation(stationId: number): Promise<void> {
  return apiFetch(`/v1/me/favorites/stations/${stationId}`, { method: "DELETE" });
}

export async function listFavoriteEvents(): Promise<{ favorites: FavoriteEvent[]; pagination: Pagination }> {
  return apiFetch("/v1/me/favorites/events");
}

export function favoriteEvent(eventId: number): Promise<void> {
  return apiFetch(`/v1/me/favorites/events/${eventId}`, { method: "PUT" });
}

export function unfavoriteEvent(eventId: number): Promise<void> {
  return apiFetch(`/v1/me/favorites/events/${eventId}`, { method: "DELETE" });
}
