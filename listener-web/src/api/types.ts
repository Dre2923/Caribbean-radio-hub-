// Mirrors backend/src/schemas/{common,stations,stationHealth,events}.ts
// exactly - this client is a consumer of those contracts, not an
// independent source of truth for them. There is no runtime validation on
// this client's side; the backend's own JSON Schema response validation
// is the real guarantee these fields are always present.

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}

export interface Country {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Language {
  id: number;
  code: string;
  name: string;
}

export interface Station {
  id: number;
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  deactivatedByUserId: number | null;
  deactivationReason: string | null;
  genres: Genre[];
  languages: Language[];
  createdAt: string;
  updatedAt: string;
}

// GET /v1/stations/ranked's own row shape (schemas/stationHealth.ts's
// rankedStationSchema) - a plain Station plus the reliability figures the
// ranking was computed from. Per docs/FLUTTER_CLIENT_SPEC.md Section
// 6.2's own note: no separate numeric "reliability score" field exists to
// render, only this object's own uptimePercentage/totalChecks, which this
// client shows as supporting context, never a score the backend doesn't
// actually return.
export interface StationReliability {
  stationId: number;
  windowHours: number;
  totalChecks: number;
  reachableChecks: number;
  uptimePercentage: number | null;
  averageLatencyMs: number | null;
}

export interface RankedStation {
  station: Station;
  reliability: StationReliability;
}

// Mirrors backend/src/schemas/common.ts's userSchema exactly.
export interface User {
  id: number;
  email: string;
  displayName: string;
  countryId: number | null;
  createdAt: string;
  role: "user" | "admin";
  roleChangedAt: string | null;
  roleChangedByUserId: number | null;
}

// Mirrors backend/src/schemas/userFeatures.ts's favorite*Schema/
// listeningHistoryEntrySchema/notificationPreferencesSchema exactly.
export interface FavoriteStation {
  station: Station;
  favoritedAt: string;
}

export interface FavoriteEvent {
  event: Event;
  favoritedAt: string;
}

export interface ListeningHistoryEntry {
  id: number;
  station: Station | null;
  listenedAt: string;
}

export interface NotificationPreferences {
  favoriteStationAvailabilityChanges: boolean;
  weeklyEventsDigest: boolean;
}

// Mirrors backend/src/schemas/voice.ts's voiceCommandResponseSchema
// exactly - exactly one of station/rankedStations/candidates/events is
// ever non-null, determined by `intent`.
export type VoiceIntent =
  | "play_station"
  | "play_ranked"
  | "playback_control"
  | "search_events"
  | "help"
  | "ambiguous"
  | "not_found"
  | "unrecognized";

export type PlaybackAction = "pause" | "resume" | "stop" | "next" | "previous";

export interface VoiceHelpTopic {
  category: string;
  examples: string[];
}

export interface VoiceCommandResult {
  intent: VoiceIntent;
  station: Station | null;
  rankedStations: Station[] | null;
  candidates: Station[] | null;
  events: Event[] | null;
  countryId: number | null;
  genreId: number | null;
  categoryId: number | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  action: PlaybackAction | null;
  helpTopics: VoiceHelpTopic[] | null;
  message: string | null;
}

// Mirrors backend/src/schemas/ads.ts's adPlacementSchema fields this
// client actually needs to render a placeholder slot and record events.
export type AdFormat = "banner" | "interstitial" | "native";

export interface AdPlacement {
  id: number;
  placementKey: string;
  countryId: number | null;
  adFormat: AdFormat;
  androidAdUnitId: string | null;
  iosAdUnitId: string | null;
  isActive: boolean;
}

export type EventStatus = "pending" | "approved" | "rejected";

export interface EventCategory {
  id: number;
  name: string;
}

export interface Event {
  id: number;
  countryId: number;
  title: string;
  description: string | null;
  venue: string | null;
  venueAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  startsAt: string;
  endsAt: string | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  status: EventStatus;
  categories: EventCategory[];
  createdByUserId: number | null;
  moderatedAt: string | null;
  moderatedByUserId: number | null;
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
  distanceKm: number | null;
}
