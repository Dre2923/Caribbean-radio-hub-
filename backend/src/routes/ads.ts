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
  InvalidFrequencyCapError,
  type AdFormat,
  type FrequencyCapPeriod,
} from "../repositories/adPlacementsRepository.js";
import {
  recordAdEvent,
  getAdPlacementReport,
  InvalidAdPlacementError,
  type AdEventType,
} from "../repositories/adEventsRepository.js";
import { errorResponseSchema, idSchema } from "../schemas/common.js";
import {
  adPlacementSchema,
  createAdPlacementBodySchema,
  updateAdPlacementBodySchema,
  listAdPlacementsQuerySchema,
  adsConfigQuerySchema,
  createAdEventBodySchema,
  adPlacementReportRowSchema,
  adPlacementReportQuerySchema,
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

// Step 57: the identical "validated here first, backstopped by the DB's
// own ad_placements_frequency_cap_together CHECK constraint" posture as
// hasAnyAdUnitId above.
function hasValidFrequencyCapPair(
  maxImpressionsPerPeriod: number | null,
  frequencyCapPeriod: FrequencyCapPeriod | null,
): boolean {
  return (maxImpressionsPerPeriod === null) === (frequencyCapPeriod === null);
}

interface CreateAdPlacementBody {
  placementKey: string;
  countryId?: number | null;
  adFormat: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
  maxImpressionsPerPeriod?: number | null;
  frequencyCapPeriod?: FrequencyCapPeriod | null;
}

interface UpdateAdPlacementBody {
  countryId?: number | null;
  adFormat?: AdFormat;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  isActive?: boolean;
  maxImpressionsPerPeriod?: number | null;
  frequencyCapPeriod?: FrequencyCapPeriod | null;
}

interface ListAdPlacementsQuery {
  countryId?: number;
  isActive?: boolean;
}

interface AdsConfigQuery {
  countryId: number;
}

interface CreateAdEventBody {
  placementId: number;
  eventType: AdEventType;
  countryId?: number;
}

interface AdPlacementReportQuery {
  countryId?: number;
  startsAfter?: string;
  startsBefore?: string;
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
          "requires at least one of androidAdUnitId/iosAdUnitId to already be set. " +
          "maxImpressionsPerPeriod/frequencyCapPeriod configure an optional frequency " +
          "cap rule (both or neither) - this backend hands the rule to the client via " +
          "GET /v1/ads/config, but never counts or enforces it itself.",
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
      const {
        placementKey,
        countryId,
        adFormat,
        androidAdUnitId,
        iosAdUnitId,
        isActive,
        maxImpressionsPerPeriod,
        frequencyCapPeriod,
      } = request.body;
      const resolvedAndroidAdUnitId = androidAdUnitId ?? null;
      const resolvedIosAdUnitId = iosAdUnitId ?? null;
      const resolvedMaxImpressionsPerPeriod = maxImpressionsPerPeriod ?? null;
      const resolvedFrequencyCapPeriod = frequencyCapPeriod ?? null;
      if (isActive && !hasAnyAdUnitId(resolvedAndroidAdUnitId, resolvedIosAdUnitId)) {
        return badRequest(
          reply,
          "An active placement needs at least one of androidAdUnitId/iosAdUnitId set",
        );
      }
      if (!hasValidFrequencyCapPair(resolvedMaxImpressionsPerPeriod, resolvedFrequencyCapPeriod)) {
        return badRequest(
          reply,
          "maxImpressionsPerPeriod and frequencyCapPeriod must be set together, or not at all",
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
          maxImpressionsPerPeriod: resolvedMaxImpressionsPerPeriod,
          frequencyCapPeriod: resolvedFrequencyCapPeriod,
        });
        return reply.status(201).send({ placement });
      } catch (err) {
        if (err instanceof DuplicateAdPlacementError) {
          return reply.status(409).send({ status: "error", message: err.message });
        }
        if (err instanceof InvalidCountryError) {
          return badRequest(reply, "countryId does not match a known country");
        }
        if (err instanceof AdPlacementMissingAdUnitError || err instanceof InvalidFrequencyCapError) {
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
          "set (either already, or in this same request). maxImpressionsPerPeriod/ " +
          "frequencyCapPeriod, if either is present, must resolve to both set or both " +
          "null (either already, or in this same request).",
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

      const {
        countryId,
        adFormat,
        androidAdUnitId,
        iosAdUnitId,
        isActive,
        maxImpressionsPerPeriod,
        frequencyCapPeriod,
      } = request.body;
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
      const nextMaxImpressionsPerPeriod =
        maxImpressionsPerPeriod !== undefined
          ? maxImpressionsPerPeriod
          : existing.maxImpressionsPerPeriod;
      const nextFrequencyCapPeriod =
        frequencyCapPeriod !== undefined ? frequencyCapPeriod : existing.frequencyCapPeriod;
      if (!hasValidFrequencyCapPair(nextMaxImpressionsPerPeriod, nextFrequencyCapPeriod)) {
        return badRequest(
          reply,
          "maxImpressionsPerPeriod and frequencyCapPeriod must be set together, or not at all",
        );
      }

      try {
        const placement = await updateAdPlacement(request.params.id, {
          countryId,
          adFormat,
          androidAdUnitId,
          iosAdUnitId,
          isActive,
          maxImpressionsPerPeriod,
          frequencyCapPeriod,
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
        if (err instanceof AdPlacementMissingAdUnitError || err instanceof InvalidFrequencyCapError) {
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

  app.post<{ Body: CreateAdEventBody }>(
    "/ads/events",
    {
      // Public, unauthenticated - most of this app's ad-eligible screens
      // require no login at all (see migration 1700000025000_ad_events's
      // own comment), so most impressions/clicks this records come from
      // anonymous listeners. A dedicated rate limit, the same per-route
      // override mechanism POST /v1/events (Step 58, OWASP API6) already
      // uses, bounds how fast a script could flood this table with fake
      // events - looser than a moderation-queue endpoint since real ad
      // traffic (a listener scrolling a banner-heavy list) can legitimately
      // fire several of these in quick succession.
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description:
          "Records a first-party impression or click for an ad placement, after the " +
          "client's own mediation SDK has already shown the ad or registered the " +
          "click - this is a report of something that already happened, not a request " +
          "to serve or approve anything. countryId is optional but recommended (it's " +
          "what makes GET /v1/admin/ads/reports's own breakdown Caribbean-specific). " +
          "Rate-limited to 60/min.",
        tags: ["ads"],
        body: createAdEventBodySchema,
        response: {
          204: { type: "null", description: "Event recorded." },
          400: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateAdEventBody }>, reply: FastifyReply) => {
      const { placementId, eventType, countryId } = request.body;
      try {
        await recordAdEvent({ placementId, eventType, countryId: countryId ?? null });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof InvalidAdPlacementError) {
          return badRequest(reply, "placementId does not match a known ad placement");
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: AdPlacementReportQuery }>(
    "/admin/ads/reports",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "First-party placement-level reporting - impression/click counts per " +
          "placement, from this backend's own recorded events (never the mediation " +
          "SDK's own numbers, which this backend has no access to). Requires an admin " +
          "account. Every currently-existing placement appears, with real 0 counts " +
          "(not omitted) when it has no matching events in the filtered window. " +
          "Optional countryId/startsAfter/startsBefore filters narrow which recorded " +
          "events count, without ever hiding a placement that simply had none.",
        tags: ["ads"],
        security: [{ bearerAuth: [] }],
        querystring: adPlacementReportQuerySchema,
        response: {
          200: {
            type: "object",
            properties: { report: { type: "array", items: adPlacementReportRowSchema } },
            required: ["report"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AdPlacementReportQuery }>) => {
      const { countryId, startsAfter, startsBefore } = request.query;
      const report = await getAdPlacementReport({ countryId, startsAfter, startsBefore });
      return { report };
    },
  );
}
