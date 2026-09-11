// Radio Master Catalog (Step 12+) schema fragments, kept in their own
// module rather than schemas/common.ts as the catalog domain grows.

import { genreSchema, languageSchema } from "./common.js";

export const MAX_STATION_NAME_LENGTH = 200; // matches radio_stations.name's column width
export const MAX_URL_LENGTH = 2048; // a practical, generous bound - not any spec's hard limit
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_STATION_SEARCH_LENGTH = 200; // matches MAX_STATION_NAME_LENGTH - never a longer match target
// Generous relative to the ~12 seeded genres and 4 seeded languages (both
// tables are meant to keep growing via curation), while still bounding an
// abusive request that tries to submit an enormous id array.
const MAX_TAG_IDS = 50;

const TAG_ID_LIST_SCHEMA = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  maxItems: MAX_TAG_IDS,
} as const;

// AJV's "uri" format checks general URI structure but not scheme; the
// pattern is what actually enforces HTTPS-only, matching the API's own
// HTTPS-end-to-end Cross-Cutting Non-Negotiable and the App Transport
// Security requirement Apple's platforms already impose on a listener's
// direct connection to this URL.
const HTTPS_URL_SCHEMA = {
  type: "string",
  format: "uri",
  pattern: "^https://",
  maxLength: MAX_URL_LENGTH,
} as const;

export const stationSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    countryId: { type: "integer" },
    name: { type: "string" },
    streamUrl: { type: "string", format: "uri" },
    websiteUrl: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    isActive: { type: "boolean" },
    genres: { type: "array", items: genreSchema },
    languages: { type: "array", items: languageSchema },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "countryId",
    "name",
    "streamUrl",
    "websiteUrl",
    "description",
    "isActive",
    "genres",
    "languages",
    "createdAt",
    "updatedAt",
  ],
} as const;

export const createStationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["countryId", "name", "streamUrl"],
  properties: {
    countryId: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: MAX_STATION_NAME_LENGTH },
    streamUrl: HTTPS_URL_SCHEMA,
    websiteUrl: HTTPS_URL_SCHEMA,
    description: { type: "string", maxLength: MAX_DESCRIPTION_LENGTH },
    genreIds: TAG_ID_LIST_SCHEMA,
    languageIds: TAG_ID_LIST_SCHEMA,
  },
} as const;

export const updateStationBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    countryId: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: MAX_STATION_NAME_LENGTH },
    streamUrl: HTTPS_URL_SCHEMA,
    websiteUrl: HTTPS_URL_SCHEMA,
    description: { type: "string", maxLength: MAX_DESCRIPTION_LENGTH },
    isActive: { type: "boolean" },
    genreIds: TAG_ID_LIST_SCHEMA,
    languageIds: TAG_ID_LIST_SCHEMA,
  },
} as const;
