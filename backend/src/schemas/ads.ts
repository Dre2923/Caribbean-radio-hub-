// Advertising (Step 56) schema fragments, kept in their own module the
// same way schemas/stations.ts/events.ts/userFeatures.ts separated out
// from schemas/common.ts.

import { idSchema, nullableIdSchema } from "./common.js";
import { AD_FORMATS } from "../repositories/adPlacementsRepository.js";

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
