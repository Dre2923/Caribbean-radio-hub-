// Stream Reliability (Step 19+) schema fragments, kept in their own module
// the same way schemas/stations.ts separated out from schemas/common.ts as
// the Radio Master Catalog domain grew.

import { stationSchema } from "./stations.js";

export const stationHealthCheckSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    stationId: { type: "integer" },
    checkedAt: { type: "string", format: "date-time" },
    isReachable: { type: "boolean" },
    statusCode: { type: ["integer", "null"] },
    latencyMs: { type: "integer" },
    error: { type: ["string", "null"] },
  },
  required: ["id", "stationId", "checkedAt", "isReachable", "statusCode", "latencyMs", "error"],
} as const;

export const stationReliabilitySchema = {
  type: "object",
  properties: {
    stationId: { type: "integer" },
    windowHours: { type: "integer" },
    totalChecks: { type: "integer" },
    reachableChecks: { type: "integer" },
    uptimePercentage: { type: ["number", "null"] },
    averageLatencyMs: { type: ["integer", "null"] },
  },
  required: [
    "stationId",
    "windowHours",
    "totalChecks",
    "reachableChecks",
    "uptimePercentage",
    "averageLatencyMs",
  ],
} as const;

// Step 22: one entry in a per-country ranked fallback chain - the full
// station (so a client can render/play it immediately, not look it up
// separately) paired with the reliability figures that placed it here.
export const rankedStationSchema = {
  type: "object",
  properties: {
    station: stationSchema,
    reliability: stationReliabilitySchema,
  },
  required: ["station", "reliability"],
} as const;
