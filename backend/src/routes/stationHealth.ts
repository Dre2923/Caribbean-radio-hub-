import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findStationById } from "../repositories/stationsRepository.js";
import {
  recordHealthCheck,
  listHealthChecks,
  getStationReliability,
  DEFAULT_RELIABILITY_WINDOW_HOURS,
  type StationHealthCheck,
} from "../repositories/stationHealthRepository.js";
import { checkStreamHealth } from "../utils/streamHealthCheck.js";
import { errorResponseSchema, idSchema } from "../schemas/common.js";
import { stationHealthCheckSchema, stationReliabilitySchema } from "../schemas/stationHealth.js";

function stationNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Station not found" });
}

async function triggerHealthCheckHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  // Deliberately not restricted to isActive: true stations - an admin
  // deciding whether to reactivate a curated-off station needs to be able
  // to check it too, the same reasoning GET /v1/admin/stations already
  // applies to visibility.
  const station = await findStationById(request.params.id);
  if (!station) {
    return stationNotFound(reply);
  }
  const result = await checkStreamHealth(station.streamUrl);
  const healthCheck = await recordHealthCheck(station.id, result);
  return reply.status(201).send({ healthCheck });
}

interface ListHealthChecksQuery {
  limit?: number;
}

async function listHealthChecksHandler(
  request: FastifyRequest<{ Params: { id: number }; Querystring: ListHealthChecksQuery }>,
  reply: FastifyReply,
) {
  const station = await findStationById(request.params.id);
  if (!station) {
    return stationNotFound(reply);
  }
  const healthChecks: StationHealthCheck[] = await listHealthChecks(
    station.id,
    request.query.limit,
  );
  return { healthChecks };
}

interface GetReliabilityQuery {
  windowHours?: number;
}

async function getReliabilityHandler(
  request: FastifyRequest<{ Params: { id: number }; Querystring: GetReliabilityQuery }>,
  reply: FastifyReply,
) {
  const station = await findStationById(request.params.id);
  if (!station) {
    return stationNotFound(reply);
  }
  const reliability = await getStationReliability(station.id, request.query.windowHours);
  return { reliability };
}

// A week is generous enough to smooth over a brief blip while still being
// "recent" - matches the spirit of docs/BUILD_MANIFEST.md's "that day's"
// ranking signal (24h default) without hard-coding a window nobody could
// ever widen for a station with sparser check history.
const MAX_RELIABILITY_WINDOW_HOURS = 168;

export async function stationHealthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: number } }>(
    "/admin/stations/:id/health-check",
    {
      // Admin-only, like every other station-catalog write - this performs
      // a real outbound network request on the caller's behalf, which is
      // exactly the kind of action that shouldn't be reachable by any
      // authenticated user, only an admin.
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Runs a real, live reachability check against a station's own streamUrl right " +
          "now (a plain GET, never reading the actual stream body) and records the result. " +
          "Requires an admin account. This is a manual, on-demand check, independent of " +
          "the automatic background sweep that also runs on a schedule (see README.md " +
          "'Stream Reliability').",
        tags: ["stream-reliability"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        response: {
          201: {
            type: "object",
            properties: { healthCheck: stationHealthCheckSchema },
            required: ["healthCheck"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    triggerHealthCheckHandler,
  );

  app.get<{ Params: { id: number }; Querystring: ListHealthChecksQuery }>(
    "/admin/stations/:id/health-checks",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Lists a station's recorded health checks, most recent first. Requires an " +
          "admin account.",
        tags: ["stream-reliability"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              healthChecks: { type: "array", items: stationHealthCheckSchema },
            },
            required: ["healthChecks"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    listHealthChecksHandler,
  );

  app.get<{ Params: { id: number }; Querystring: GetReliabilityQuery }>(
    "/admin/stations/:id/reliability",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Computes a station's reliability over a recent window (default " +
          `${DEFAULT_RELIABILITY_WINDOW_HOURS}h, "that day's" signal) from its recorded ` +
          "health checks: uptimePercentage (reachable / total, null if no checks fall in " +
          "the window - never 0, which would wrongly imply a confirmed-bad track record) " +
          "and averageLatencyMs (across reachable checks only). Requires an admin account. " +
          "This is the measurement the per-country quality ranking is built on.",
        tags: ["stream-reliability"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            windowHours: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RELIABILITY_WINDOW_HOURS,
              default: DEFAULT_RELIABILITY_WINDOW_HOURS,
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { reliability: stationReliabilitySchema },
            required: ["reliability"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    getReliabilityHandler,
  );
}
