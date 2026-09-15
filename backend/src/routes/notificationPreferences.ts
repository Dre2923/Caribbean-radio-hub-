import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "../repositories/notificationPreferencesRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  notificationPreferencesSchema,
  updateNotificationPreferencesBodySchema,
} from "../schemas/userFeatures.js";

type UpdateNotificationPreferencesBody = Partial<NotificationPreferences>;

export async function notificationPreferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/me/notification-preferences",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Returns the authenticated user's notification preferences. A user with no " +
          "preferences ever set gets the default (favoriteStationAvailabilityChanges: true) " +
          "- there's no meaningful difference between 'never customized' and 'explicitly set " +
          "to the default'.",
        tags: ["notification-preferences"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: { preferences: notificationPreferencesSchema },
            required: ["preferences"],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest) => {
      const preferences = await getNotificationPreferences(request.user.sub);
      return { preferences };
    },
  );

  app.patch<{ Body: UpdateNotificationPreferencesBody }>(
    "/me/notification-preferences",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Updates the authenticated user's notification preferences. All fields optional " +
          "(at least one required); only the fields present are changed.",
        tags: ["notification-preferences"],
        security: [{ bearerAuth: [] }],
        body: updateNotificationPreferencesBodySchema,
        response: {
          200: {
            type: "object",
            properties: { preferences: notificationPreferencesSchema },
            required: ["preferences"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: UpdateNotificationPreferencesBody }>) => {
      const preferences = await updateNotificationPreferences(request.user.sub, request.body);
      return { preferences };
    },
  );
}
