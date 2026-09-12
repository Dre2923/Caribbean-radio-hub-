// User Features (Step 51+) schema fragments, kept in their own module the
// same way schemas/stations.ts and schemas/events.ts separated out from
// schemas/common.ts.

import { stationSchema } from "./stations.js";
import { eventSchema } from "./events.js";

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
