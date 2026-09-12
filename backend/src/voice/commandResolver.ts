// Step 34: the foundation of the Voice System bucket (Steps 34-38).
//
// Per docs/ARCHITECTURE_PLAN.md's architecture research (sourced, not
// assumed): on-device speech-to-text is the correct low-latency
// architecture, so the backend never receives raw audio or talks to a
// paid STT provider - only the transcribed text ever crosses the network.
// This module is the entire "intent-out" half of that split: pure
// text-in, structured-command-out resolution, with zero dependency on any
// external NLU service. A finite, well-scoped command grammar (play a
// station by name, play a genre in a country, five playback-control
// verbs) is resolved with deterministic keyword/phrase matching against
// this app's own small, real vocabularies (genres, countries, the station
// catalog) - a real, defensible v1 for a domain this bounded, not a
// corner cut: pulling in a general-purpose NLU/ML dependency (or a paid
// cloud NLU API) to classify a dozen intents against a 13-country,
// 12-genre vocabulary would be solving a problem this app doesn't have.
//
// Playback control (pause/resume/stop/next/previous) resolves to a bare
// intent with no data - the backend has no server-side "now playing"
// state to act on (that's the Flutter client's own audio session, Steps
// 46-50); this endpoint's only job for those verbs is classifying which
// one was spoken, so the client acts on its own local state immediately.

import { listGenres, type Genre } from "../repositories/genresRepository.js";
import { listActiveCountries, type Country } from "../repositories/countriesRepository.js";
import { listStations, type Station } from "../repositories/stationsRepository.js";
import { getRankedStationsForCountry } from "../repositories/stationRankingRepository.js";

export type VoiceIntent =
  | "play_station"
  | "play_ranked"
  | "playback_control"
  | "ambiguous"
  | "not_found"
  | "unrecognized";

export type PlaybackAction = "pause" | "resume" | "stop" | "next" | "previous";

export interface VoiceCommandResult {
  intent: VoiceIntent;
  station: Station | null;
  rankedStations: Station[] | null;
  candidates: Station[] | null;
  countryId: number | null;
  genreId: number | null;
  action: PlaybackAction | null;
  message: string | null;
}

export interface VoiceCommandContext {
  // The requesting user's own profile country (users.country_id), used as
  // the implicit "in my country" when a genre-only command doesn't name
  // one explicitly ("play reggae" vs. "play reggae in Jamaica") - the
  // same personalization data source PATCH /v1/me already exposes,
  // reused here rather than inventing a separate "voice preferences"
  // concept.
  defaultCountryId: number | null;
}

function emptyResult(intent: VoiceIntent, overrides: Partial<VoiceCommandResult> = {}): VoiceCommandResult {
  return {
    intent,
    station: null,
    rankedStations: null,
    candidates: null,
    countryId: null,
    genreId: null,
    action: null,
    message: null,
    ...overrides,
  };
}

// Collapses spelling/punctuation variation this app's own real vocabulary
// actually has ("St. Lucia" vs "Saint Lucia", "Antigua & Barbuda" vs
// "Turks and Caicos", a leading "the Bahamas") down to a comparable form -
// not a general-purpose fuzzy-matching library, just enough normalization
// for the specific 13 country names and 12 genre names this app seeds.
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bst\.?\s+/g, "saint ")
    .replace(/[&]/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Exact match (or an exact country-code match) always wins; a substring
// match only counts once the normalized phrase has enough characters to
// not spuriously match nearly everything (a bare "a" or "in" is never a
// meaningful country/genre reference).
const MIN_SUBSTRING_MATCH_LENGTH = 3;

function findCountryMatch(phrase: string, countries: Country[]): Country | null {
  const normalizedPhrase = normalizeForMatch(phrase);
  const codeMatch = countries.find((country) => country.code.toLowerCase() === phrase.trim().toLowerCase());
  if (codeMatch) return codeMatch;

  const exactMatch = countries.find((country) => normalizeForMatch(country.name) === normalizedPhrase);
  if (exactMatch) return exactMatch;

  if (normalizedPhrase.length < MIN_SUBSTRING_MATCH_LENGTH) return null;
  return (
    countries.find((country) => {
      const normalizedName = normalizeForMatch(country.name);
      return normalizedName.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedName);
    }) ?? null
  );
}

// A genre-only command ("play music in Jamaica") names no real genre at
// all - these are the filler words that mean "no genre preference," not
// an unrecognized genre.
const GENERIC_GENRE_FILLERS = new Set([
  "music",
  "something",
  "anything",
  "radio",
  "a station",
  "the radio",
  "some music",
  "a radio station",
]);

function findGenreMatch(phrase: string, genres: Genre[]): Genre | null {
  const normalizedPhrase = normalizeForMatch(phrase);
  if (GENERIC_GENRE_FILLERS.has(normalizedPhrase)) return null;

  const exactMatch = genres.find((genre) => normalizeForMatch(genre.name) === normalizedPhrase);
  if (exactMatch) return exactMatch;

  if (normalizedPhrase.length < MIN_SUBSTRING_MATCH_LENGTH) return null;
  return (
    genres.find((genre) => {
      const normalizedName = normalizeForMatch(genre.name);
      return normalizedName.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedName);
    }) ?? null
  );
}

const PLAYBACK_CONTROL_PHRASES: Record<string, PlaybackAction> = {
  pause: "pause",
  "pause it": "pause",
  "pause the station": "pause",
  resume: "resume",
  unpause: "resume",
  continue: "resume",
  "continue playing": "resume",
  stop: "stop",
  "stop it": "stop",
  "stop playing": "stop",
  next: "next",
  "next station": "next",
  skip: "next",
  "skip station": "next",
  "skip this": "next",
  previous: "previous",
  "previous station": "previous",
  "go back": "previous",
  back: "previous",
  "last station": "previous",
};

// Resolves a genre+country pair (genreId is null for "any genre") against
// the existing Step 22 reliability ranking - never a new ranking query.
// getRankedStationsForCountry already returns every active station in the
// country, best-first by recent streaming reliability; a genre filter is
// applied afterward, in-memory, preserving that same order, rather than
// re-deriving a ranking that would need to exist at the database layer.
// This is intentionally a pure orchestration of two existing capabilities
// (Steps 14/22), never a new one.
async function resolveRankedIntent(countryId: number, genre: Genre | null): Promise<VoiceCommandResult> {
  const ranked = await getRankedStationsForCountry(countryId);
  const matching = genre
    ? ranked.filter((entry) => entry.station.genres.some((g) => g.id === genre.id))
    : ranked;

  if (matching.length === 0) {
    return emptyResult("not_found", {
      countryId,
      genreId: genre?.id ?? null,
      message: genre
        ? `No ${genre.name} stations found for that country.`
        : "No stations found for that country.",
    });
  }

  return emptyResult("play_ranked", {
    countryId,
    genreId: genre?.id ?? null,
    rankedStations: matching.map((entry) => entry.station),
  });
}

const GENRE_AND_COUNTRY_PATTERN = /^play (?:the )?(.+?) in (?:the )?(.+)$/i;
const BARE_PLAY_PATTERN = /^play (?:the )?(.+)$/i;

export async function resolveVoiceCommand(
  rawText: string,
  context: VoiceCommandContext,
): Promise<VoiceCommandResult> {
  const text = rawText.trim().replace(/[.,!?]+$/g, "");
  const normalized = normalizeForMatch(text);

  const playbackAction = PLAYBACK_CONTROL_PHRASES[normalized];
  if (playbackAction) {
    return emptyResult("playback_control", { action: playbackAction });
  }

  const genreAndCountryMatch = GENRE_AND_COUNTRY_PATTERN.exec(text);
  if (genreAndCountryMatch) {
    const [, genrePhrase, countryPhrase] = genreAndCountryMatch;
    const [countries, genres] = await Promise.all([listActiveCountries(), listGenres()]);
    const country = findCountryMatch(countryPhrase, countries);
    if (!country) {
      return emptyResult("not_found", { message: `Couldn't find a country matching "${countryPhrase.trim()}".` });
    }
    const genre = findGenreMatch(genrePhrase, genres);
    if (!genre && !GENERIC_GENRE_FILLERS.has(normalizeForMatch(genrePhrase))) {
      // Named something, but it isn't a known filler *or* a known genre -
      // rather than silently falling back to "any genre" (which would
      // quietly ignore what the user actually asked for), this is
      // reported as not found so the client can ask for clarification.
      return emptyResult("not_found", {
        countryId: country.id,
        message: `Couldn't find a genre matching "${genrePhrase.trim()}".`,
      });
    }
    return resolveRankedIntent(country.id, genre);
  }

  const barePlayMatch = BARE_PLAY_PATTERN.exec(text);
  if (barePlayMatch) {
    const [, phrase] = barePlayMatch;
    const trimmedPhrase = phrase.trim();

    const { stations } = await listStations({ search: trimmedPhrase, isActive: true, limit: 5 });
    const exactStationMatch = stations.find(
      (station) => normalizeForMatch(station.name) === normalizeForMatch(trimmedPhrase),
    );
    if (exactStationMatch) {
      return emptyResult("play_station", { station: exactStationMatch });
    }
    if (stations.length === 1) {
      return emptyResult("play_station", { station: stations[0] });
    }
    if (stations.length > 1) {
      return emptyResult("ambiguous", {
        candidates: stations,
        message: `Found ${stations.length} stations matching "${trimmedPhrase}" - which one?`,
      });
    }

    // No station name matched at all - try it as a bare genre request
    // ("play reggae"), defaulting to the requester's own profile country.
    const genres = await listGenres();
    const genre = findGenreMatch(trimmedPhrase, genres);
    if (genre) {
      if (context.defaultCountryId === null) {
        return emptyResult("not_found", {
          genreId: genre.id,
          message: `Please specify a country, e.g. "play ${genre.name.toLowerCase()} in Jamaica".`,
        });
      }
      return resolveRankedIntent(context.defaultCountryId, genre);
    }

    return emptyResult("not_found", { message: `Couldn't find a station or genre matching "${trimmedPhrase}".` });
  }

  return emptyResult("unrecognized", { message: "Sorry, I didn't understand that command." });
}
