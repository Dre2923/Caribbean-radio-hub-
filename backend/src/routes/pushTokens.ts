import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  registerPushToken,
  removePushToken,
  listPushTokens,
  PushTokenUserNotFoundError,
  TooManyPushTokensError,
  DEFAULT_PUSH_TOKEN_LIST_LIMIT,
  MAX_PUSH_TOKEN_LIST_LIMIT,
  MAX_PUSH_TOKENS_PER_USER,
  type PushPlatform,
} from "../repositories/pushTokensRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  pushTokenSchema,
  createPushTokenBodySchema,
  deletePushTokenBodySchema,
} from "../schemas/userFeatures.js";

interface RegisterPushTokenBody {
  token: string;
  platform: PushPlatform;
}

interface RemovePushTokenBody {
  token: string;
}

interface ListQuery {
  limit?: number;
  offset?: number;
}

export async function pushTokensRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterPushTokenBody }>(
    "/me/push-tokens",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Registers (or re-registers) a device push token for the authenticated user. " +
          "Idempotent by design: registering a token that's already known overwrites its " +
          "owner and platform and refreshes updated_at, rather than erroring - this is how a " +
          "client reports its own periodic FCM token refresh, or a different account now " +
          `signed in on the same device. Capped at ${MAX_PUSH_TOKENS_PER_USER} registered ` +
          "devices per account (409 once reached) - re-registering an already-owned token " +
          "never counts against this cap.",
        tags: ["push-tokens"],
        security: [{ bearerAuth: [] }],
        body: createPushTokenBodySchema,
        response: {
          204: { type: "null", description: "Token registered." },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: RegisterPushTokenBody }>, reply: FastifyReply) => {
      try {
        await registerPushToken(request.user.sub, request.body.token, request.body.platform);
      } catch (err) {
        if (err instanceof PushTokenUserNotFoundError) {
          return reply.status(404).send({ status: "error", message: "User not found" });
        }
        if (err instanceof TooManyPushTokensError) {
          return reply.status(409).send({ status: "error", message: err.message });
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/me/push-tokens",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Lists the authenticated user's registered devices, most-recently-refreshed " +
          `first. Paginated with limit (default ${DEFAULT_PUSH_TOKEN_LIST_LIMIT}, max ` +
          `${MAX_PUSH_TOKEN_LIST_LIMIT}) and offset.`,
        tags: ["push-tokens"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_PUSH_TOKEN_LIST_LIMIT,
              default: DEFAULT_PUSH_TOKEN_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              pushTokens: { type: "array", items: pushTokenSchema },
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
            required: ["pushTokens", "pagination"],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ListQuery }>) => {
      const { limit, offset } = request.query;
      const { pushTokens, total } = await listPushTokens(request.user.sub, { limit, offset });
      return {
        pushTokens,
        pagination: { total, limit: limit ?? DEFAULT_PUSH_TOKEN_LIST_LIMIT, offset: offset ?? 0 },
      };
    },
  );

  app.delete<{ Body: RemovePushTokenBody }>(
    "/me/push-tokens",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Un-registers a device push token for the authenticated user (e.g. on logout). " +
          "Idempotent - succeeds whether or not the token was registered, or registered to " +
          "this account.",
        tags: ["push-tokens"],
        security: [{ bearerAuth: [] }],
        body: deletePushTokenBodySchema,
        response: {
          204: { type: "null", description: "Token un-registered." },
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: RemovePushTokenBody }>, reply: FastifyReply) => {
      await removePushToken(request.user.sub, request.body.token);
      return reply.status(204).send();
    },
  );
}
