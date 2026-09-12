// User Features (Step 51+) schema fragments, kept in their own module the
// same way schemas/stations.ts and schemas/events.ts separated out from
// schemas/common.ts.

import { stationSchema } from "./stations.js";
import { eventSchema } from "./events.js";
import { PUSH_PLATFORMS } from "../repositories/pushTokensRepository.js";

// A generous, deliberately-bounded cap on a registered push token's
// length - real FCM tokens run well under this, but this endpoint accepts
// arbitrary client-supplied text, so the same "assume every input is
// hostile" standard applied to every other free-text field in this API
// applies here too.
export const MAX_PUSH_TOKEN_LENGTH = 4096;

// Each favorite is its own object wrapping the full resource plus when it
// was favorited, rather than bolting a favoritedAt field onto stationSchema/
// eventSchema themselves - those shared schemas are reused by every other
// station/event-returning endpoint in the API, where "when did the current
// caller favorite this" has no meaning at all. Keeping it here instead
// means every other endpoint's response shape is untouched by this feature.
export const favoriteStationSchema = {
  type: "object",
  properties: {
    station: stationSchema,
    favoritedAt: { type: "string", format: "date-time" },
  },
  required: ["station", "favoritedAt"],
} as const;

export const favoriteEventSchema = {
  type: "object",
  properties: {
    event: eventSchema,
    favoritedAt: { type: "string", format: "date-time" },
  },
  required: ["event", "favoritedAt"],
} as const;

// Step 52: a listening-history entry. station is nullable - unlike a
// favorite, this is a historical record that outlives the station it
// pointed to (see migration 1700000020000_listening_history's comment on
// why that column is ON DELETE SET NULL rather than CASCADE).
export const listeningHistoryEntrySchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    station: { anyOf: [stationSchema, { type: "null" }] },
    listenedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "station", "listenedAt"],
} as const;

// Step 53: a registered device push token.
export const pushTokenSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    token: { type: "string" },
    platform: { type: "string", enum: [...PUSH_PLATFORMS] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "token", "platform", "createdAt", "updatedAt"],
} as const;

export const createPushTokenBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "platform"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: MAX_PUSH_TOKEN_LENGTH },
    platform: { type: "string", enum: [...PUSH_PLATFORMS] },
  },
} as const;

export const deletePushTokenBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: MAX_PUSH_TOKEN_LENGTH },
  },
} as const;
