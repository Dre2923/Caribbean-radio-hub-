// Advertising (Step 56) schema fragments, kept in their own module the
// same way schemas/stations.ts/events.ts/userFeatures.ts separated out
// from schemas/common.ts.

import { idSchema, nullableIdSchema } from "./common.js";
import { AD_FORMATS, FREQUENCY_CAP_PERIODS } from "../repositories/adPlacementsRepository.js";
import { AD_EVENT_TYPES } from "../repositories/adEventsRepository.js";

// A generous, deliberately-bounded length for a client-supplied ad unit
// id - real AdMob ad unit ids are short, fixed-shape strings
// (ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX), but this is still arbitrary
// client-supplied text, the same "assume every input is hostile" standard
// already applied to every other free-text field in this API.
export const MAX_AD_UNIT_ID_LENGTH = 200;
// Matches radio_stations.name's own bound (schemas/stations.ts) - not a
// hard external limit, just a practical, generous one for a short
// human-readable identifier.
export const MAX_PLACEMENT_KEY_LENGTH = 200;

const AD_UNIT_ID_SCHEMA = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: MAX_AD_UNIT_ID_LENGTH,
} as const;

// Step 57: a real, enforced upper bound on a frequency cap value - not
// idSchema's int4 ceiling (this isn't a foreign-key id, but it is still
// stored in a Postgres `integer` column, so the exact unbounded-integer
// hazard Step 55 fixed elsewhere would reappear here without one), and
// deliberately much lower: no legitimate placement caps itself at more
// than a few dozen shows a day, so a generous-but-real domain bound
// (matching MAX_PUSH_TOKENS_PER_USER/MAX_TAG_IDS's own "generous, not
// unlimited" shape) catches a nonsensical value long before it would ever
// need Postgres's own range to reject it.
export const MAX_IMPRESSIONS_PER_PERIOD = 1000;

const MAX_IMPRESSIONS_PER_PERIOD_SCHEMA = {
  type: ["integer", "null"],
  minimum: 1,
  maximum: MAX_IMPRESSIONS_PER_PERIOD,
} as const;

const FREQUENCY_CAP_PERIOD_SCHEMA = {
  type: ["string", "null"],
  enum: [...FREQUENCY_CAP_PERIODS, null],
} as const;

export const adPlacementSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    placementKey: { type: "string" },
    // null means "the global default for this placement" - see the
    // migration's own comment for the full country_id design reasoning.
    countryId: { type: ["integer", "null"] },
    adFormat: { type: "string", enum: [...AD_FORMATS] },
    androidAdUnitId: { type: ["string", "null"] },
    iosAdUnitId: { type: ["string", "null"] },
    isActive: { type: "boolean" },
    // Step 57: null together means no cap configured - see
    // adPlacementsRepository.ts's own AdPlacement interface comment.
    maxImpressionsPerPeriod: { type: ["integer", "null"] },
    frequencyCapPeriod: { type: ["string", "null"], enum: [...FREQUENCY_CAP_PERIODS, null] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "placementKey",
    "countryId",
    "adFormat",
    "androidAdUnitId",
    "iosAdUnitId",
    "isActive",
    "maxImpressionsPerPeriod",
    "frequencyCapPeriod",
    "createdAt",
    "updatedAt",
  ],
} as const;

export const createAdPlacementBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["placementKey", "adFormat"],
  properties: {
    placementKey: { type: "string", minLength: 1, maxLength: MAX_PLACEMENT_KEY_LENGTH },
    countryId: nullableIdSchema,
    adFormat: { type: "string", enum: [...AD_FORMATS] },
    androidAdUnitId: AD_UNIT_ID_SCHEMA,
    iosAdUnitId: AD_UNIT_ID_SCHEMA,
    isActive: { type: "boolean" },
    maxImpressionsPerPeriod: MAX_IMPRESSIONS_PER_PERIOD_SCHEMA,
    frequencyCapPeriod: FREQUENCY_CAP_PERIOD_SCHEMA,
  },
} as const;

export const updateAdPlacementBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    countryId: nullableIdSchema,
    adFormat: { type: "string", enum: [...AD_FORMATS] },
    androidAdUnitId: AD_UNIT_ID_SCHEMA,
    iosAdUnitId: AD_UNIT_ID_SCHEMA,
    isActive: { type: "boolean" },
    maxImpressionsPerPeriod: MAX_IMPRESSIONS_PER_PERIOD_SCHEMA,
    frequencyCapPeriod: FREQUENCY_CAP_PERIOD_SCHEMA,
  },
} as const;

export const listAdPlacementsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    countryId: idSchema,
    isActive: { type: "boolean" },
  },
} as const;

export const adsConfigQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["countryId"],
  properties: {
    countryId: idSchema,
  },
} as const;

// Step 57: first-party placement-level reporting.

export const createAdEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["placementId", "eventType"],
  properties: {
    placementId: idSchema,
    eventType: { type: "string", enum: [...AD_EVENT_TYPES] },
    // Optional, unlike GET /v1/ads/config's own required countryId - many
    // real callers (a client that already resolved config once and cached
    // it) may not have a country in scope by the time an event fires, and
    // an event with no country is still meaningful (it just won't appear
    // in a country-filtered report).
    countryId: idSchema,
  },
} as const;

export const adPlacementReportRowSchema = {
  type: "object",
  properties: {
    placementId: { type: "integer" },
    placementKey: { type: "string" },
    impressions: { type: "integer" },
    clicks: { type: "integer" },
  },
  required: ["placementId", "placementKey", "impressions", "clicks"],
} as const;

export const adPlacementReportQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    countryId: idSchema,
    startsAfter: { type: "string", format: "date-time" },
    startsBefore: { type: "string", format: "date-time" },
  },
} as const;

// Step 62: the precomputed daily rollup - see
// repositories/adPerformanceRepository.ts for why a row's absence for a
// given placement/date means real zero, not missing data.
export const adPerformanceDailyRowSchema = {
  type: "object",
  properties: {
    placementId: { type: "integer" },
    placementKey: { type: "string" },
    date: { type: "string", format: "date" },
    impressions: { type: "integer" },
    clicks: { type: "integer" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["placementId", "placementKey", "date", "impressions", "clicks", "updatedAt"],
} as const;

export const adPerformanceDailyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    placementId: idSchema,
    startDate: { type: "string", format: "date" },
    endDate: { type: "string", format: "date" },
  },
} as const;
