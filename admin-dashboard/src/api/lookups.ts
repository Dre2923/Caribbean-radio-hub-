import { apiFetch } from "./client";
import type { Country, Genre, Language } from "./types";

// All three are public, no-auth endpoints (see backend/README.md), used
// here purely as reference data to populate filter dropdowns - the
// dashboard never writes to any of them.
export async function listCountries(): Promise<Country[]> {
  const { countries } = await apiFetch<{ countries: Country[] }>("/v1/countries");
  return countries;
}

export async function listGenres(): Promise<Genre[]> {
  const { genres } = await apiFetch<{ genres: Genre[] }>("/v1/genres");
  return genres;
}

export async function listLanguages(): Promise<Language[]> {
  const { languages } = await apiFetch<{ languages: Language[] }>("/v1/languages");
  return languages;
}
