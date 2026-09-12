// Events Database (Step 24+) schema fragments, kept in their own module
// the same way schemas/stations.ts separated out from schemas/common.ts.

import { eventCategorySchema } from "./common.js";

export const MAX_EVENT_TITLE_LENGTH = 200; // matches events.title's column width
export const MAX_EVENT_VENUE_LENGTH = 300; // matches events.venue's column width
export const MAX_EVENT_DESCRIPTION_LENGTH = 2000;
export const MAX_EVENT_SEARCH_LENGTH = 200; // matches MAX_EVENT_TITLE_LENGTH - never a longer match target
export const MAX_URL_LENGTH = 2048; // a practical, generous bound - not any spec's hard limit
// Generous relative to the seeded starter set of event categories (both
// tables are meant to keep growing via curation), while still bounding an
// abusive request that tries to submit an enormous id array - the same
// reasoning as schemas/stations.ts's MAX_TAG_IDS.
const MAX_CATEGORY_IDS = 50;

// Same HTTPS-only reasoning as schemas/stations.ts's HTTPS_URL_SCHEMA -
// AJV's "uri" format checks general URI structure but not scheme.
const HTTPS_URL_SCHEMA = {
  type: "string",
  format: "uri",
  pattern: "^https://",
  maxLength: MAX_URL_LENGTH,
} as const;

const CATEGORY_ID_LIST_SCHEMA = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  maxItems: MAX_CATEGORY_IDS,
} as const;

export const EVENT_STATUSES = ["pending", "approved", "rejected"] as const;

export const eventSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    countryId: { type: "integer" },
    title: { type: "string" },
    description: { type: ["string", "null"] },
    venue: { type: ["string", "null"] },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: ["string", "null"], format: "date-time" },
    imageUrl: { type: ["string", "null"] },
    ticketUrl: { type: ["string", "null"] },
    status: { type: "string", enum: [...EVENT_STATUSES] },
    categories: { type: "array", items: eventCategorySchema },
    // Whoever submitted it - null if their account has since been deleted
    // (created_by_user_id is SET NULL on delete, the same reasoning as
    // radio_stations.created_by_user_id) or, in principle, for a row that
    // predates attribution.
    createdByUserId: { type: ["integer", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "countryId",
    "title",
    "description",
    "venue",
    "startsAt",
    "endsAt",
    "imageUrl",
    "ticketUrl",
    "status",
    "categories",
    "createdByUserId",
    "createdAt",
    "updatedAt",
  ],
} as const;

export const createEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["countryId", "title", "startsAt"],
  properties: {
    countryId: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: MAX_EVENT_TITLE_LENGTH },
    description: { type: "string", maxLength: MAX_EVENT_DESCRIPTION_LENGTH },
    venue: { type: "string", minLength: 1, maxLength: MAX_EVENT_VENUE_LENGTH },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: "string", format: "date-time" },
    imageUrl: HTTPS_URL_SCHEMA,
    ticketUrl: HTTPS_URL_SCHEMA,
    categoryIds: CATEGORY_ID_LIST_SCHEMA,
  },
} as const;

export const updateEventBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    countryId: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: MAX_EVENT_TITLE_LENGTH },
    description: { type: "string", maxLength: MAX_EVENT_DESCRIPTION_LENGTH },
    venue: { type: "string", minLength: 1, maxLength: MAX_EVENT_VENUE_LENGTH },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: "string", format: "date-time" },
    imageUrl: HTTPS_URL_SCHEMA,
    ticketUrl: HTTPS_URL_SCHEMA,
    categoryIds: CATEGORY_ID_LIST_SCHEMA,
    // Admin-only in practice (see routes/events.ts) - this is how
    // moderation actually happens: PATCH { status: "approved" } or
    // { status: "rejected" } on a pending submission, the same
    // "curation is just another PATCH-able field" pattern already
    // established for radio_stations.isActive.
    status: { type: "string", enum: [...EVENT_STATUSES] },
  },
} as const;
