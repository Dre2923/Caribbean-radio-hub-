import { apiFetch } from "./client";
import type { Country, EventCategory, Genre, Language } from "./types";

// Small, effectively-static reference data - per
// docs/FLUTTER_CLIENT_SPEC.md Section 9.4's own note, these are cheap
// enough and re-fetched often enough (once per app load, via React
// Query's own cache) that no persistent local cache is needed for them,
// unlike the station/event directory data (see hooks/useOfflineCache.ts).

export function listCountries(): Promise<{ countries: Country[] }> {
  return apiFetch("/v1/countries");
}

export function listGenres(): Promise<{ genres: Genre[] }> {
  return apiFetch("/v1/genres");
}

export function listLanguages(): Promise<{ languages: Language[] }> {
  return apiFetch("/v1/languages");
}

export function listEventCategories(): Promise<{ categories: EventCategory[] }> {
  return apiFetch("/v1/event-categories");
}
