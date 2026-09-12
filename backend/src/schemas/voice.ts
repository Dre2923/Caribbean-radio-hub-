// Voice System (Step 34+) schema fragments, kept in their own module the
// same way stations/events separated out from schemas/common.ts.

import { stationSchema } from "./stations.js";

// A spoken sentence transcribed client-side (see commandResolver.ts's
// module comment) - generous enough for a real command but bounded
// against a client bug or abuse sending an enormous payload.
export const MAX_VOICE_COMMAND_TEXT_LENGTH = 500;

export const VOICE_INTENTS = [
  "play_station",
  "play_ranked",
  "playback_control",
  "ambiguous",
  "not_found",
  "unrecognized",
] as const;

export const PLAYBACK_ACTIONS = ["pause", "resume", "stop", "next", "previous"] as const;

export const voiceCommandBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_VOICE_COMMAND_TEXT_LENGTH },
  },
} as const;

export const voiceCommandResponseSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...VOICE_INTENTS] },
    // Exactly one of station/rankedStations/candidates is ever non-null,
    // determined by `intent` - null on every field a given intent doesn't
    // use, the same "null means not applicable to this result" convention
    // as events.ts's distanceKm.
    station: { anyOf: [stationSchema, { type: "null" }] },
    rankedStations: { type: ["array", "null"], items: stationSchema },
    candidates: { type: ["array", "null"], items: stationSchema },
    countryId: { type: ["integer", "null"] },
    genreId: { type: ["integer", "null"] },
    action: { type: ["string", "null"], enum: [...PLAYBACK_ACTIONS, null] },
    message: { type: ["string", "null"] },
  },
  required: ["intent", "station", "rankedStations", "candidates", "countryId", "genreId", "action", "message"],
} as const;
