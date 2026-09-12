// Stream Reliability (Step 19+) schema fragments, kept in their own module
// the same way schemas/stations.ts separated out from schemas/common.ts as
// the Radio Master Catalog domain grew.

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
