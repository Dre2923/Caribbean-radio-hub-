import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findStationById } from "../repositories/stationsRepository.js";
import {
  recordHealthCheck,
  listHealthChecks,
  type StationHealthCheck,
} from "../repositories/stationHealthRepository.js";
import { checkStreamHealth } from "../utils/streamHealthCheck.js";
import { errorResponseSchema } from "../schemas/common.js";
import { stationHealthCheckSchema } from "../schemas/stationHealth.js";

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
          "Requires an admin account. This is a manual, on-demand check - Stream " +
          "Reliability's automatic recurring checks are a later step.",
        tags: ["stream-reliability"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
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
          properties: { id: { type: "integer", minimum: 1 } },
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
}
