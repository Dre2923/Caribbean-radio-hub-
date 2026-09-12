import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  recordListen,
  listListeningHistory,
  clearListeningHistory,
  InvalidStationError,
  DEFAULT_HISTORY_LIST_LIMIT,
  MAX_HISTORY_LIST_LIMIT,
} from "../repositories/listeningHistoryRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import { listeningHistoryEntrySchema } from "../schemas/userFeatures.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

interface RecordListenBody {
  stationId?: number;
}

interface ListHistoryQuery {
  limit?: number;
  offset?: number;
}

export async function listeningHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RecordListenBody }>(
    "/me/listening-history",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Records that the authenticated user just listened to a station. The backend " +
          "holds no server-side 'now playing' state (a listener's device connects directly " +
          "to a station's own stream), so this is entirely client-reported - the client " +
          "calls this when it starts playback. listenedAt is always the server's own current " +
          "time, never client-supplied.",
        tags: ["listening-history"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["stationId"],
          properties: {
            stationId: { type: "integer", minimum: 1 },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { entry: listeningHistoryEntrySchema },
            required: ["entry"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: RecordListenBody }>, reply: FastifyReply) => {
      const stationId = request.body.stationId as number;
      try {
        const entry = await recordListen(request.user.sub, stationId);
        return reply.status(201).send({ entry });
      } catch (err) {
        if (err instanceof InvalidStationError) {
          return badRequest(reply, "stationId does not match a known station");
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: ListHistoryQuery }>(
    "/me/listening-history",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Lists the authenticated user's listening history, most-recently-listened first. " +
          "A station later hard-deleted still appears (station: null) - the record that a " +
          `listen happened is preserved. Paginated with limit (default ${DEFAULT_HISTORY_LIST_LIMIT}, ` +
          `max ${MAX_HISTORY_LIST_LIMIT}) and offset.`,
        tags: ["listening-history"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_HISTORY_LIST_LIMIT,
              default: DEFAULT_HISTORY_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              entries: { type: "array", items: listeningHistoryEntrySchema },
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
            required: ["entries", "pagination"],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ListHistoryQuery }>) => {
      const { limit, offset } = request.query;
      const { entries, total } = await listListeningHistory(request.user.sub, { limit, offset });
      return {
        entries,
        pagination: { total, limit: limit ?? DEFAULT_HISTORY_LIST_LIMIT, offset: offset ?? 0 },
      };
    },
  );

  app.delete(
    "/me/listening-history",
    {
      preHandler: app.authenticate,
      schema: {
        description: "Permanently clears the authenticated user's entire listening history.",
        tags: ["listening-history"],
        security: [{ bearerAuth: [] }],
        response: {
          204: { type: "null", description: "History cleared." },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await clearListeningHistory(request.user.sub);
      return reply.status(204).send();
    },
  );
}
