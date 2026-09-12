import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createStation,
  deleteStation,
  findStationById,
  listStations,
  updateStation,
  DEFAULT_STATION_LIST_LIMIT,
  MAX_STATION_LIST_LIMIT,
  DuplicateStreamUrlError,
  NearDuplicateStreamUrlError,
  InvalidCountryError,
  InvalidGenreError,
  InvalidLanguageError,
} from "../repositories/stationsRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  createStationBodySchema,
  stationSchema,
  updateStationBodySchema,
  MAX_STATION_SEARCH_LENGTH,
} from "../schemas/stations.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

function stationNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Station not found" });
}

interface ListStationsQuery {
  countryId?: number;
  genreId?: number;
  languageId?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

async function listStationsHandler(request: FastifyRequest<{ Querystring: ListStationsQuery }>) {
  const { countryId, genreId, languageId, q, limit, offset } = request.query;
  // Always active-only, and never client-controlled: this is the public
  // catalog listing, never a place a curated-off (Step 17) or
  // not-yet-approved station should appear. GET /v1/admin/stations (below)
  // is the admin-only route with full visibility.
  const { stations, total } = await listStations({
    countryId,
    genreId,
    languageId,
    search: q,
    isActive: true,
    limit,
    offset,
  });
  return {
    stations,
    pagination: {
      total,
      limit: limit ?? DEFAULT_STATION_LIST_LIMIT,
      offset: offset ?? 0,
    },
  };
}

interface AdminListStationsQuery {
  countryId?: number;
  genreId?: number;
  languageId?: number;
  q?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

async function listAdminStationsHandler(
  request: FastifyRequest<{ Querystring: AdminListStationsQuery }>,
) {
  const { countryId, genreId, languageId, q, isActive, limit, offset } = request.query;
  // isActive is undefined unless the caller explicitly filters - showing
  // every station regardless of curation state is the entire point of
  // this route existing (deciding what to re-activate, auditing what's
  // been curated off, finding a station that isn't showing up publicly).
  const { stations, total } = await listStations({
    countryId,
    genreId,
    languageId,
    search: q,
    isActive,
    limit,
    offset,
  });
  return {
    stations,
    pagination: {
      total,
      limit: limit ?? DEFAULT_STATION_LIST_LIMIT,
      offset: offset ?? 0,
    },
  };
}

async function getStationHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  const station = await findStationById(request.params.id);
  if (!station || !station.isActive) {
    // Same 404 whether the id doesn't exist at all or belongs to a
    // curated-off station - the public API never signals "this station
    // exists but is hidden," which would leak curation state to anyone
    // probing ids.
    return stationNotFound(reply);
  }
  return { station };
}

interface TrimmableStationFields {
  name?: string;
  description?: string;
  streamUrl?: string;
  websiteUrl?: string;
}

// Trims every free-text field a station body can carry - the same input
// hygiene already applied to email/displayName on POST /v1/users and
// PATCH /v1/me. Runs in preValidation (before schema checks), so a
// copy-pasted stream URL or name with stray leading/trailing whitespace
// still validates cleanly instead of failing minLength/pattern checks - or
// worse, silently persisting the whitespace into the catalog - over
// formatting a human wouldn't even notice they'd introduced.
function trimStationBodyStrings(body: Partial<TrimmableStationFields> | undefined): void {
  if (!body) return;
  for (const field of ["name", "description", "streamUrl", "websiteUrl"] as const) {
    const value = body[field];
    if (typeof value === "string") {
      body[field] = value.trim();
    }
  }
}

interface CreateStationBody {
  countryId: number;
  name: string;
  streamUrl: string;
  websiteUrl?: string;
  description?: string;
  genreIds?: number[];
  languageIds?: number[];
}

async function createStationHandler(
  request: FastifyRequest<{ Body: CreateStationBody }>,
  reply: FastifyReply,
) {
  const { countryId, name, streamUrl, websiteUrl, description, genreIds, languageIds } =
    request.body;
  try {
    const station = await createStation({
      countryId,
      name,
      streamUrl,
      websiteUrl: websiteUrl ?? null,
      description: description ?? null,
      genreIds,
      languageIds,
      createdByUserId: request.user.sub,
    });
    return reply.status(201).send({ station });
  } catch (err) {
    if (err instanceof DuplicateStreamUrlError || err instanceof NearDuplicateStreamUrlError) {
      return reply.status(409).send({ status: "error", message: err.message });
    }
    if (err instanceof InvalidCountryError) {
      return badRequest(reply, "countryId does not match a known country");
    }
    if (err instanceof InvalidGenreError || err instanceof InvalidLanguageError) {
      return badRequest(reply, err.message);
    }
    throw err;
  }
}

interface UpdateStationBody {
  countryId?: number;
  name?: string;
  streamUrl?: string;
  websiteUrl?: string;
  description?: string;
  isActive?: boolean;
  genreIds?: number[];
  languageIds?: number[];
}

async function updateStationHandler(
  request: FastifyRequest<{ Params: { id: number }; Body: UpdateStationBody }>,
  reply: FastifyReply,
) {
  try {
    const station = await updateStation(request.params.id, request.body);
    if (!station) {
      return stationNotFound(reply);
    }
    return { station };
  } catch (err) {
    if (err instanceof DuplicateStreamUrlError || err instanceof NearDuplicateStreamUrlError) {
      return reply.status(409).send({ status: "error", message: err.message });
    }
    if (err instanceof InvalidCountryError) {
      return badRequest(reply, "countryId does not match a known country");
    }
    if (err instanceof InvalidGenreError || err instanceof InvalidLanguageError) {
      return badRequest(reply, err.message);
    }
    throw err;
  }
}

async function deleteStationHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  const deleted = await deleteStation(request.params.id);
  if (!deleted) {
    return stationNotFound(reply);
  }
  return reply.status(204).send();
}

export async function stationsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListStationsQuery }>(
    "/stations",
    {
      schema: {
        description:
          "Lists active radio stations. Filter with countryId/genreId/languageId " +
          "(each narrows the results further, combined with AND) and/or q (a " +
          "case-insensitive substring match against the station name). Paginated " +
          `with limit (default ${DEFAULT_STATION_LIST_LIMIT}, max ${MAX_STATION_LIST_LIMIT}) and offset.`,
        tags: ["stations"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            countryId: { type: "integer", minimum: 1 },
            genreId: { type: "integer", minimum: 1 },
            languageId: { type: "integer", minimum: 1 },
            q: { type: "string", minLength: 1, maxLength: MAX_STATION_SEARCH_LENGTH },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_STATION_LIST_LIMIT,
              default: DEFAULT_STATION_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              stations: { type: "array", items: stationSchema },
              pagination: {
                type: "object",
                properties: {
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                },
                required: ["total", "limit", "offset"],
              },
            },
            required: ["stations", "pagination"],
          },
          400: errorResponseSchema,
        },
      },
    },
    listStationsHandler,
  );

  app.get<{ Querystring: AdminListStationsQuery }>(
    "/admin/stations",
    {
      // Admin-only - this is the one place the catalog's full, unfiltered
      // curation state (every inactive/curated-off station included) is
      // visible at all. The public route above can never be coaxed into
      // this by a query param; this is a structurally separate route.
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Lists radio stations with full visibility (including inactive/curated-off " +
          "ones) for admin curation. Requires an admin account. Same filters as " +
          "GET /v1/stations, plus isActive to filter to exactly active or inactive - " +
          "omit isActive to see everything regardless of curation state.",
        tags: ["stations"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            countryId: { type: "integer", minimum: 1 },
            genreId: { type: "integer", minimum: 1 },
            languageId: { type: "integer", minimum: 1 },
            q: { type: "string", minLength: 1, maxLength: MAX_STATION_SEARCH_LENGTH },
            isActive: { type: "boolean" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_STATION_LIST_LIMIT,
              default: DEFAULT_STATION_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              stations: { type: "array", items: stationSchema },
              pagination: {
                type: "object",
                properties: {
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                },
                required: ["total", "limit", "offset"],
              },
            },
            required: ["stations", "pagination"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    listAdminStationsHandler,
  );

  app.get<{ Params: { id: number } }>(
    "/stations/:id",
    {
      schema: {
        description: "Returns a single active radio station.",
        tags: ["stations"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        response: {
          200: {
            type: "object",
            properties: { station: stationSchema },
            required: ["station"],
          },
          404: errorResponseSchema,
        },
      },
    },
    getStationHandler,
  );

  app.post<{ Body: CreateStationBody }>(
    "/stations",
    {
      // Admin-only (Step 11's app.requireAdmin) - the public catalog is
      // read-only; curating it is exactly the kind of action that
      // shouldn't be reachable by any authenticated user, only an admin.
      preHandler: [app.authenticate, app.requireAdmin],
      preValidation: (request, reply, done) => {
        trimStationBodyStrings(request.body as Partial<TrimmableStationFields> | undefined);
        done();
      },
      schema: {
        description:
          "Creates a radio station. Requires an admin account. Optional genreIds/" +
          "languageIds attach it to existing genres (GET /v1/genres) and languages " +
          "(GET /v1/languages).",
        tags: ["stations"],
        security: [{ bearerAuth: [] }],
        body: createStationBodySchema,
        response: {
          201: {
            type: "object",
            properties: { station: stationSchema },
            required: ["station"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    createStationHandler,
  );

  app.patch<{ Params: { id: number }; Body: UpdateStationBody }>(
    "/stations/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      preValidation: (request, reply, done) => {
        trimStationBodyStrings(request.body as Partial<TrimmableStationFields> | undefined);
        done();
      },
      schema: {
        description:
          "Updates a radio station. Requires an admin account. All fields optional; only " +
          "the fields present are changed. Setting isActive: false pulls it from the " +
          "public catalog without deleting its history. genreIds/languageIds, if " +
          "present, replace the station's full set of each - omit them to leave " +
          "existing associations untouched, or send [] to clear them.",
        tags: ["stations"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        body: updateStationBodySchema,
        response: {
          200: {
            type: "object",
            properties: { station: stationSchema },
            required: ["station"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    updateStationHandler,
  );

  app.delete<{ Params: { id: number } }>(
    "/stations/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Permanently deletes a radio station. Requires an admin account. Prefer " +
          "PATCH { isActive: false } to pull a station from the catalog while keeping " +
          "its history - this is for removing a genuine mistake, not routine curation.",
        tags: ["stations"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        response: {
          204: { type: "null", description: "Station deleted." },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    deleteStationHandler,
  );
}
