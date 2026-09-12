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
import { listEventCategories, type EventCategory } from "../repositories/eventCategoriesRepository.js";
import { listEvents, type Event } from "../repositories/eventsRepository.js";

export type VoiceIntent =
  | "play_station"
  | "play_ranked"
  | "playback_control"
  | "search_events"
  | "ambiguous"
  | "not_found"
  | "unrecognized";

export type PlaybackAction = "pause" | "resume" | "stop" | "next" | "previous";

export interface VoiceCommandResult {
  intent: VoiceIntent;
  station: Station | null;
  rankedStations: Station[] | null;
  candidates: Station[] | null;
  events: Event[] | null;
  countryId: number | null;
  genreId: number | null;
  categoryId: number | null;
  // Only non-null for a search_events result that named a relative date
  // phrase ("today"/"tomorrow"/"this weekend") - echoed back (not just
  // applied silently) so the client can display what range was actually
  // searched, the same "surface what was resolved" reasoning as
  // countryId/genreId on a play_ranked result.
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
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
    events: null,
    countryId: null,
    genreId: null,
    categoryId: null,
    dateRangeStart: null,
    dateRangeEnd: null,
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

// An events command naming no real category ("find any events in Jamaica")
// means "no category filter," the identical convention as
// GENERIC_GENRE_FILLERS above.
const GENERIC_CATEGORY_FILLERS = new Set(["any", "all", "anything", "any kind", "any events", "all events"]);

function findCategoryMatch(phrase: string, categories: EventCategory[]): EventCategory | null {
  const normalizedPhrase = normalizeForMatch(phrase);
  if (GENERIC_CATEGORY_FILLERS.has(normalizedPhrase)) return null;

  const exactMatch = categories.find((category) => normalizeForMatch(category.name) === normalizedPhrase);
  if (exactMatch) return exactMatch;

  if (normalizedPhrase.length < MIN_SUBSTRING_MATCH_LENGTH) return null;
  return (
    categories.find((category) => {
      const normalizedName = normalizeForMatch(category.name);
      return normalizedName.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedName);
    }) ?? null
  );
}

// Every "day"/"weekend" boundary here is computed in UTC. A genuinely
// correct "today in the user's own timezone" would need a per-user or
// per-country timezone this schema doesn't store yet (Caribbean countries
// span a narrow band, AST/EST-ish, so a UTC day boundary is rarely more
// than a few hours off from any of them) - a documented simplification,
// not an oversight, and one a future per-user timezone field could
// tighten without changing this function's shape.
interface DateRange {
  start: Date;
  end: Date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  const end = startOfUtcDay(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function getTodayRange(now: Date): DateRange {
  return { start: startOfUtcDay(now), end: endOfUtcDay(now) };
}

function getTomorrowRange(now: Date): DateRange {
  const tomorrow = new Date(startOfUtcDay(now));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { start: tomorrow, end: endOfUtcDay(tomorrow) };
}

// Saturday through Sunday. If today already IS Saturday or Sunday, "this
// weekend" means the remainder of the weekend already under way - never a
// week further out, which "this" (as opposed to "next") weekend would
// wrongly imply.
function getThisWeekendRange(now: Date): DateRange {
  const today = startOfUtcDay(now);
  const dayOfWeek = today.getUTCDay(); // 0 = Sunday, 6 = Saturday

  if (dayOfWeek === 0) {
    return { start: today, end: endOfUtcDay(today) };
  }

  const start = new Date(today);
  if (dayOfWeek !== 6) {
    start.setUTCDate(start.getUTCDate() + (6 - dayOfWeek));
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end: endOfUtcDay(end) };
}

const DATE_PHRASE_RESOLVERS: Record<string, (now: Date) => DateRange> = {
  today: getTodayRange,
  tomorrow: getTomorrowRange,
  "this weekend": getThisWeekendRange,
};
const DATE_PHRASE_PATTERN = /\s+(today|tomorrow|this weekend)$/i;

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

// Resolves an events search (optional category, optional country, optional
// pre-computed relative date range) against the existing public events
// listing (Steps 26/29/30) - status: "approved"/upcomingOnly: true
// unconditionally, the identical, non-negotiable "never surface a
// pending/rejected submission" restriction GET /v1/events itself always
// applies (see routes/events.ts's listEventsHandler) - a voice command is
// still just another client of the public listing, never the moderation
// queue. Capped to a short list (EVENT_LIST_LIMIT) since a voice
// interface reads results aloud/shows a short list, not a full paginated
// browse.
const EVENT_LIST_LIMIT = 5;

async function resolveEventSearch(
  categoryPhrase: string | undefined,
  countryPhrase: string | undefined,
  dateRange: DateRange | null,
  context: VoiceCommandContext,
): Promise<VoiceCommandResult> {
  const [countries, categories] = await Promise.all([listActiveCountries(), listEventCategories()]);

  // Unlike a genre-only station play, an events search with no named
  // country isn't asked to specify one - "what's happening this weekend"
  // with no country and no profile default is still a coherent request
  // (browse everything), not a missing-information error.
  let countryId: number | null = context.defaultCountryId;
  if (countryPhrase) {
    const country = findCountryMatch(countryPhrase, countries);
    if (!country) {
      return emptyResult("not_found", { message: `Couldn't find a country matching "${countryPhrase.trim()}".` });
    }
    countryId = country.id;
  }

  let categoryId: number | null = null;
  if (categoryPhrase) {
    const category = findCategoryMatch(categoryPhrase, categories);
    if (!category && !GENERIC_CATEGORY_FILLERS.has(normalizeForMatch(categoryPhrase))) {
      return emptyResult("not_found", {
        countryId,
        message: `Couldn't find an event category matching "${categoryPhrase.trim()}".`,
      });
    }
    categoryId = category?.id ?? null;
  }

  const { events } = await listEvents({
    countryId: countryId ?? undefined,
    categoryId: categoryId ?? undefined,
    status: "approved",
    upcomingOnly: true,
    startsAfter: dateRange ? dateRange.start.toISOString() : undefined,
    startsBefore: dateRange ? dateRange.end.toISOString() : undefined,
    limit: EVENT_LIST_LIMIT,
  });

  const dateRangeFields = {
    dateRangeStart: dateRange?.start.toISOString() ?? null,
    dateRangeEnd: dateRange?.end.toISOString() ?? null,
  };

  if (events.length === 0) {
    return emptyResult("not_found", {
      countryId,
      categoryId,
      ...dateRangeFields,
      message: "No matching events found.",
    });
  }

  return emptyResult("search_events", { countryId, categoryId, ...dateRangeFields, events });
}

const GENRE_AND_COUNTRY_PATTERN = /^play (?:the )?(.+?) in (?:the )?(.+)$/i;
const BARE_PLAY_PATTERN = /^play (?:the )?(.+)$/i;

// A small set of accepted lead-ins, stripped before the main grammar
// applies - "find events in Jamaica" and "events in Jamaica" resolve
// identically. Deliberately narrow (see this module's own top-of-file
// reasoning for why a rule-based grammar is the right scope here): this
// is a documented, finite set of accepted phrasings, not an attempt at
// open-ended natural language understanding.
const EVENT_LEAD_IN_PATTERN = /^(?:find|what|which|show me|show|search for|search)\s+/i;
// Matches "events", "events in <country>", "<category> events", and
// "<category> events in <country>" - group 1 is the optional category
// phrase, group 2 the optional country phrase (both resolved against this
// app's real vocabularies by findCategoryMatch/findCountryMatch).
const EVENT_SEARCH_PATTERN = /^(?:(.+?)\s+)?events?(?:\s+in\s+(?:the\s+)?(.+))?$/i;

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

  // A trailing relative-date phrase is stripped before the events grammar
  // applies, so "events in Jamaica this weekend" and "events in Jamaica"
  // both parse the same category/country structure - the date range (if
  // any) is resolved separately and passed through as its own argument.
  const dateMatch = DATE_PHRASE_PATTERN.exec(text);
  const datePhrase = dateMatch?.[1]?.toLowerCase();
  const dateStripped = dateMatch ? text.slice(0, dateMatch.index) : text;
  const eventSearchMatch = EVENT_SEARCH_PATTERN.exec(dateStripped.replace(EVENT_LEAD_IN_PATTERN, ""));
  if (eventSearchMatch) {
    const [, categoryPhrase, countryPhrase] = eventSearchMatch;
    const dateRange = datePhrase ? DATE_PHRASE_RESOLVERS[datePhrase](new Date()) : null;
    return resolveEventSearch(categoryPhrase, countryPhrase, dateRange, context);
  }

  return emptyResult("unrecognized", { message: "Sorry, I didn't understand that command." });
}
