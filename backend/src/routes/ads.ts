import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAdPlacement,
  updateAdPlacement,
  deleteAdPlacement,
  getAdPlacementById,
  listAdPlacements,
  getActiveAdPlacementsForCountry,
  DuplicateAdPlacementError,
  InvalidCountryError,
  AdPlacementMissingAdUnitError,
  type AdFormat,
} from "../repositories/adPlacementsRepository.js";
import { errorResponseSchema, idSchema } from "../schemas/common.js";
import {
  adPlacementSchema,
  createAdPlacementBodySchema,
  updateAdPlacementBodySchema,
  listAdPlacementsQuerySchema,
  adsConfigQuerySchema,
} from "../schemas/ads.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

function placementNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Ad placement not found" });
}

// Applied identically on create and update - the same rule the database's
// own ad_placements_active_requires_ad_unit_id CHECK constraint enforces
// as a backstop (migration 1700000023000_ad_placements). Checking it here
// first gives a specific, friendly 400 on the common path; the DB
// constraint only fires if this is ever bypassed (a concurrent update
// racing this same check, or a future code path that forgets to call it).
function hasAnyAdUnitId(androidAdUnitId: string | null, iosAdUnitId: string | null): boolean {
  return androidAdUnitId !== null || iosAdUnitId !== null;
}

interface CreateAdPlacementBody {
  placementKey: string;
  countryId?: number | null;
  adFormat: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
}

interface UpdateAdPlacementBody {
  countryId?: number | null;
  adFormat?: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
}

interface ListAdPlacementsQuery {
  countryId?: number;
  isActive?: boolean;
}

interface AdsConfigQuery {
  countryId: number;
}

export async function adsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateAdPlacementBody }>(
    "/admin/ads/placements",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Creates an ad placement. Requires an admin account. countryId null (the " +
          "default) creates the global fallback for this placementKey; a specific " +
          "countryId creates an override for that country only - the client always " +
          "prefers a country-specific active placement over the global one for the " +
          "same placementKey (GET /v1/ads/config). isActive defaults to false (a " +
          "placement can be staged with its ad unit ids added later); activating it " +
          "requires at least one of androidAdUnitId/iosAdUnitId to already be set.",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        body: createAdPlacementBodySchema,
        response: {
          201: {
            type: "object",
            properties: { placement: adPlacementSchema },
            required: ["placement"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateAdPlacementBody }>, reply: FastifyReply) => {
      const { placementKey, countryId, adFormat, androidAdUnitId, iosAdUnitId, isActive } =
        request.body;
      const resolvedAndroidAdUnitId = androidAdUnitId ?? null;
      const resolvedIosAdUnitId = iosAdUnitId ?? null;
      if (isActive && !hasAnyAdUnitId(resolvedAndroidAdUnitId, resolvedIosAdUnitId)) {
        return badRequest(
          reply,
          "An active placement needs at least one of androidAdUnitId/iosAdUnitId set",
        );
      }
      try {
        const placement = await createAdPlacement({
          placementKey,
          countryId: countryId ?? null,
          adFormat,
          androidAdUnitId: resolvedAndroidAdUnitId,
          iosAdUnitId: resolvedIosAdUnitId,
          isActive,
        });
        return reply.status(201).send({ placement });
      } catch (err) {
        if (err instanceof DuplicateAdPlacementError) {
          return reply.status(409).send({ status: "error", message: err.message });
        }
        if (err instanceof InvalidCountryError) {
          return badRequest(reply, "countryId does not match a known country");
        }
        if (err instanceof AdPlacementMissingAdUnitError) {
          return badRequest(reply, err.message);
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: ListAdPlacementsQuery }>(
    "/admin/ads/placements",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Lists ad placements with full visibility (every country override and the " +
          "global default, active or not). Requires an admin account. Optional " +
          "countryId/isActive filters.",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        querystring: listAdPlacementsQuerySchema,
        response: {
          200: {
            type: "object",
            properties: { placements: { type: "array", items: adPlacementSchema } },
            required: ["placements"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ListAdPlacementsQuery }>) => {
      const { countryId, isActive } = request.query;
      const placements = await listAdPlacements({ countryId, isActive });
      return { placements };
    },
  );

  app.get<{ Params: { id: number } }>(
    "/admin/ads/placements/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description: "Returns a single ad placement by id. Requires an admin account.",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        response: {
          200: {
            type: "object",
            properties: { placement: adPlacementSchema },
            required: ["placement"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const placement = await getAdPlacementById(request.params.id);
      if (!placement) return placementNotFound(reply);
      return { placement };
    },
  );

  app.patch<{ Params: { id: number }; Body: UpdateAdPlacementBody }>(
    "/admin/ads/placements/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Updates an ad placement. Requires an admin account. All fields optional " +
          "(at least one required); only the fields present are changed. Setting " +
          "isActive: true requires at least one of androidAdUnitId/iosAdUnitId to be " +
          "set (either already, or in this same request).",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        body: updateAdPlacementBodySchema,
        response: {
          200: {
            type: "object",
            properties: { placement: adPlacementSchema },
            required: ["placement"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: number }; Body: UpdateAdPlacementBody }>,
      reply: FastifyReply,
    ) => {
      const existing = await getAdPlacementById(request.params.id);
      if (!existing) return placementNotFound(reply);

      const { countryId, adFormat, androidAdUnitId, iosAdUnitId, isActive } = request.body;
      const nextAndroidAdUnitId =
        androidAdUnitId !== undefined ? androidAdUnitId : existing.androidAdUnitId;
      const nextIosAdUnitId = iosAdUnitId !== undefined ? iosAdUnitId : existing.iosAdUnitId;
      const nextIsActive = isActive ?? existing.isActive;
      if (nextIsActive && !hasAnyAdUnitId(nextAndroidAdUnitId, nextIosAdUnitId)) {
        return badRequest(
          reply,
          "An active placement needs at least one of androidAdUnitId/iosAdUnitId set",
        );
      }

      try {
        const placement = await updateAdPlacement(request.params.id, {
          countryId,
          adFormat,
          androidAdUnitId,
          iosAdUnitId,
          isActive,
        });
        if (!placement) return placementNotFound(reply);
        return { placement };
      } catch (err) {
        if (err instanceof DuplicateAdPlacementError) {
          return reply.status(409).send({ status: "error", message: err.message });
        }
        if (err instanceof InvalidCountryError) {
          return badRequest(reply, "countryId does not match a known country");
        }
        if (err instanceof AdPlacementMissingAdUnitError) {
          return badRequest(reply, err.message);
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: number } }>(
    "/admin/ads/placements/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description: "Deletes an ad placement. Requires an admin account.",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        response: {
          204: { type: "null", description: "Placement deleted." },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const existing = await getAdPlacementById(request.params.id);
      if (!existing) return placementNotFound(reply);
      await deleteAdPlacement(request.params.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: AdsConfigQuery }>(
    "/ads/config",
    {
      schema: {
        description:
          "The real client-facing ad configuration for a given country: one entry " +
          "per active placementKey visible to that country, preferring a " +
          "country-specific override over the global default when both exist. " +
          "Public, unauthenticated - a client resolves this once per session (or on " +
          "country change) to know which ad unit ids to hand to its own mediation " +
          "SDK, per docs/ARCHITECTURE_PLAN.md's own scoped backend role for " +
          "Advertising (configuration only, never ad serving/tracking itself).",
        tags: ["ads"],
        querystring: adsConfigQuerySchema,
        response: {
          200: {
            type: "object",
            properties: { placements: { type: "array", items: adPlacementSchema } },
            required: ["placements"],
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AdsConfigQuery }>) => {
      const placements = await getActiveAdPlacementsForCountry(request.query.countryId);
      return { placements };
    },
  );
}
