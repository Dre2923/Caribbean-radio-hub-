import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findStationById } from "../repositories/stationsRepository.js";
import { findEventById } from "../repositories/eventsRepository.js";
import {
  addFavoriteStation,
  removeFavoriteStation,
  listFavoriteStations,
  addFavoriteEvent,
  removeFavoriteEvent,
  listFavoriteEvents,
  FavoriteStationNotFoundError,
  FavoriteEventNotFoundError,
  DEFAULT_FAVORITE_LIST_LIMIT,
  MAX_FAVORITE_LIST_LIMIT,
} from "../repositories/favoritesRepository.js";
import { errorResponseSchema, idSchema } from "../schemas/common.js";
import { favoriteStationSchema, favoriteEventSchema } from "../schemas/userFeatures.js";

function stationNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Station not found" });
}

function eventNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Event not found" });
}

const paginationSchema = {
  type: "object",
  properties: {
    total: { type: "integer" },
    limit: { type: "integer" },
    offset: { type: "integer" },
  },
  required: ["total", "limit", "offset"],
} as const;

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_FAVORITE_LIST_LIMIT,
      default: DEFAULT_FAVORITE_LIST_LIMIT,
    },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

interface ListQuery {
  limit?: number;
  offset?: number;
}

interface FavoriteStationParams {
  stationId: number;
}

interface FavoriteEventParams {
  eventId: number;
}

export async function favoritesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/me/favorites/stations",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Lists the authenticated user's favorited radio stations, most-recently-favorited " +
          "first. A station favorited before being curated off (isActive: false) keeps its " +
          `favorite but is omitted here until it's reactivated. Paginated with limit (default ${DEFAULT_FAVORITE_LIST_LIMIT}, ` +
          `max ${MAX_FAVORITE_LIST_LIMIT}) and offset.`,
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              favorites: { type: "array", items: favoriteStationSchema },
              pagination: paginationSchema,
            },
            required: ["favorites", "pagination"],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ListQuery }>) => {
      const { limit, offset } = request.query;
      const { favorites, total } = await listFavoriteStations(request.user.sub, { limit, offset });
      return {
        favorites,
        pagination: { total, limit: limit ?? DEFAULT_FAVORITE_LIST_LIMIT, offset: offset ?? 0 },
      };
    },
  );

  app.put<{ Params: FavoriteStationParams }>(
    "/me/favorites/stations/:stationId",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Favorites a station for the authenticated user. Idempotent - favoriting an " +
          "already-favorited station succeeds with no error. 404 for an unknown or " +
          "curated-off (inactive) station - the same response either way as GET /v1/stations/:id.",
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: { stationId: idSchema },
          required: ["stationId"],
        },
        response: {
          204: { type: "null", description: "Station favorited." },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: FavoriteStationParams }>, reply: FastifyReply) => {
      const station = await findStationById(request.params.stationId);
      if (!station || !station.isActive) {
        return stationNotFound(reply);
      }
      try {
        await addFavoriteStation(request.user.sub, request.params.stationId);
      } catch (err) {
        if (err instanceof FavoriteStationNotFoundError) {
          return stationNotFound(reply);
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: FavoriteStationParams }>(
    "/me/favorites/stations/:stationId",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Un-favorites a station for the authenticated user. Idempotent - succeeds whether " +
          "or not the station was favorited, or even still exists.",
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: { stationId: idSchema },
          required: ["stationId"],
        },
        response: {
          204: { type: "null", description: "Station un-favorited." },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: FavoriteStationParams }>, reply: FastifyReply) => {
      await removeFavoriteStation(request.user.sub, request.params.stationId);
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/me/favorites/events",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Lists the authenticated user's favorited events, most-recently-favorited first. " +
          "An event favorited while approved and later rejected keeps its favorite but is " +
          `omitted here while hidden. Paginated with limit (default ${DEFAULT_FAVORITE_LIST_LIMIT}, ` +
          `max ${MAX_FAVORITE_LIST_LIMIT}) and offset.`,
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              favorites: { type: "array", items: favoriteEventSchema },
              pagination: paginationSchema,
            },
            required: ["favorites", "pagination"],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ListQuery }>) => {
      const { limit, offset } = request.query;
      const { favorites, total } = await listFavoriteEvents(request.user.sub, { limit, offset });
      return {
        favorites,
        pagination: { total, limit: limit ?? DEFAULT_FAVORITE_LIST_LIMIT, offset: offset ?? 0 },
      };
    },
  );

  app.put<{ Params: FavoriteEventParams }>(
    "/me/favorites/events/:eventId",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Favorites an event for the authenticated user. Idempotent - favoriting an " +
          "already-favorited event succeeds with no error. 404 for an unknown, pending, " +
          "or rejected event - the same response either way as GET /v1/events/:id.",
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: { eventId: idSchema },
          required: ["eventId"],
        },
        response: {
          204: { type: "null", description: "Event favorited." },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: FavoriteEventParams }>, reply: FastifyReply) => {
      const event = await findEventById(request.params.eventId);
      if (!event || event.status !== "approved") {
        return eventNotFound(reply);
      }
      try {
        await addFavoriteEvent(request.user.sub, request.params.eventId);
      } catch (err) {
        if (err instanceof FavoriteEventNotFoundError) {
          return eventNotFound(reply);
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: FavoriteEventParams }>(
    "/me/favorites/events/:eventId",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Un-favorites an event for the authenticated user. Idempotent - succeeds whether " +
          "or not the event was favorited, or even still exists.",
        tags: ["favorites"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: { eventId: idSchema },
          required: ["eventId"],
        },
        response: {
          204: { type: "null", description: "Event un-favorited." },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: FavoriteEventParams }>, reply: FastifyReply) => {
      await removeFavoriteEvent(request.user.sub, request.params.eventId);
      return reply.status(204).send();
    },
  );
}
