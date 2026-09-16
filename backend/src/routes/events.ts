import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createEvent,
  deleteEvent,
  findEventById,
  listEvents,
  updateEvent,
  DEFAULT_EVENT_LIST_LIMIT,
  MAX_EVENT_LIST_LIMIT,
  InvalidCountryError,
  InvalidEndsAtError,
  InvalidEventCategoryError,
  DuplicateEventError,
  InvalidLocationError,
  type EventStatus,
} from "../repositories/eventsRepository.js";
import { getUserRole } from "../repositories/usersRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  createEventBodySchema,
  eventSchema,
  updateEventBodySchema,
  MAX_EVENT_SEARCH_LENGTH,
} from "../schemas/events.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

// A reversed range (startsAfter after startsBefore) isn't unsafe - it just
// silently produces an always-empty result, which is more likely a client
// mistake than an intentional query. A real 400 here is more useful than a
// confusing empty list, the same "route around the actual confusion" spirit
// as PATCH /v1/stations/:id's deactivationReason/isActive cross-field check.
function validDateRange(startsAfter?: string, startsBefore?: string): boolean {
  if (startsAfter === undefined || startsBefore === undefined) return true;
  return new Date(startsAfter).getTime() <= new Date(startsBefore).getTime();
}

// Step 30: nearLatitude/nearLongitude must be given together (a lone
// coordinate can't center a search), and radiusKm without either is
// meaningless - the same "route around the actual confusion with a real
// 400" spirit as validDateRange above, applied before this ever reaches
// the repository.
function validNearLocationParams(
  nearLatitude?: number,
  nearLongitude?: number,
  radiusKm?: number,
): boolean {
  const hasCenter = nearLatitude !== undefined && nearLongitude !== undefined;
  if ((nearLatitude !== undefined) !== (nearLongitude !== undefined)) return false;
  if (radiusKm !== undefined && !hasCenter) return false;
  return true;
}

function eventNotFound(reply: FastifyReply) {
  return reply.status(404).send({ status: "error", message: "Event not found" });
}

interface TrimmableEventFields {
  title?: string;
  description?: string;
  venue?: string;
  venueAddress?: string;
  imageUrl?: string;
  ticketUrl?: string;
  moderationReason?: string;
}

// Same input-hygiene reasoning as routes/stations.ts's trimStationBodyStrings
// - runs in preValidation, before schema length checks, so incidental
// leading/trailing whitespace never fails minLength/maxLength or persists
// into a submission a moderator later has to read.
function trimEventBodyStrings(body: Partial<TrimmableEventFields> | undefined): void {
  if (!body) return;
  for (const field of [
    "title",
    "description",
    "venue",
    "venueAddress",
    "imageUrl",
    "ticketUrl",
    "moderationReason",
  ] as const) {
    const value = body[field];
    if (typeof value === "string") {
      body[field] = value.trim();
    }
  }
}

interface ListEventsQuery {
  countryId?: number;
  categoryId?: number;
  q?: string;
  startsAfter?: string;
  startsBefore?: string;
  includePast?: boolean;
  nearLatitude?: number;
  nearLongitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
}

async function listEventsHandler(
  request: FastifyRequest<{ Querystring: ListEventsQuery }>,
  reply: FastifyReply,
) {
  const {
    countryId,
    categoryId,
    q,
    startsAfter,
    startsBefore,
    includePast,
    nearLatitude,
    nearLongitude,
    radiusKm,
    limit,
    offset,
  } = request.query;
  if (!validDateRange(startsAfter, startsBefore)) {
    return badRequest(reply, "startsAfter must not be after startsBefore");
  }
  if (!validNearLocationParams(nearLatitude, nearLongitude, radiusKm)) {
    return badRequest(
      reply,
      "nearLatitude and nearLongitude must both be provided together, and radiusKm requires both",
    );
  }
  // Always approved-only, never client-controlled - the public listing must
  // never surface a pending or rejected submission. GET /v1/admin/events
  // (below) is the admin-only route with full moderation visibility.
  // upcomingOnly defaults to true (excludes a concluded event) unless the
  // caller explicitly opts in with includePast - see EventListFilter's
  // own comment for why this, unlike status, is a real client-controlled
  // choice rather than something the public route hard-codes.
  const { events, total } = await listEvents({
    countryId,
    categoryId,
    search: q,
    startsAfter,
    startsBefore,
    status: "approved",
    upcomingOnly: !includePast,
    nearLatitude,
    nearLongitude,
    radiusKm,
    limit,
    offset,
  });
  return {
    events,
    pagination: {
      total,
      limit: limit ?? DEFAULT_EVENT_LIST_LIMIT,
      offset: offset ?? 0,
    },
  };
}

interface AdminListEventsQuery {
  countryId?: number;
  categoryId?: number;
  q?: string;
  startsAfter?: string;
  startsBefore?: string;
  status?: EventStatus;
  upcomingOnly?: boolean;
  nearLatitude?: number;
  nearLongitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
}

async function listAdminEventsHandler(
  request: FastifyRequest<{ Querystring: AdminListEventsQuery }>,
  reply: FastifyReply,
) {
  const {
    countryId,
    categoryId,
    q,
    startsAfter,
    startsBefore,
    status,
    upcomingOnly,
    nearLatitude,
    nearLongitude,
    radiusKm,
    limit,
    offset,
  } = request.query;
  if (!validDateRange(startsAfter, startsBefore)) {
    return badRequest(reply, "startsAfter must not be after startsBefore");
  }
  if (!validNearLocationParams(nearLatitude, nearLongitude, radiusKm)) {
    return badRequest(
      reply,
      "nearLatitude and nearLongitude must both be provided together, and radiusKm requires both",
    );
  }
  // status is undefined unless the caller explicitly filters - showing
  // every submission regardless of moderation state is the entire point of
  // this route: it's the moderation queue itself, not just an audit view.
  // upcomingOnly is likewise undefined (no time filtering at all) unless
  // the caller explicitly asks to narrow to just what's still upcoming -
  // a moderator reviewing the queue needs to see a concluded event too
  // (e.g. one submitted and rejected after the fact), so this is never
  // hard-coded the way the public route hard-codes status.
  const { events, total } = await listEvents({
    countryId,
    categoryId,
    search: q,
    startsAfter,
    startsBefore,
    status,
    upcomingOnly,
    nearLatitude,
    nearLongitude,
    radiusKm,
    limit,
    offset,
  });
  return {
    events,
    pagination: {
      total,
      limit: limit ?? DEFAULT_EVENT_LIST_LIMIT,
      offset: offset ?? 0,
    },
  };
}

async function getEventHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  const event = await findEventById(request.params.id);
  if (!event || event.status !== "approved") {
    // Same reasoning as routes/stations.ts's getStationHandler: an
    // unrecognized id and a pending/rejected one both 404 identically, so
    // the public API never leaks moderation state to anyone probing ids.
    return eventNotFound(reply);
  }
  return { event };
}

interface CreateEventBody {
  countryId: number;
  title: string;
  description?: string;
  venue?: string;
  venueAddress?: string;
  latitude?: number;
  longitude?: number;
  startsAt: string;
  endsAt?: string;
  imageUrl?: string;
  ticketUrl?: string;
  categoryIds?: number[];
}

async function createEventHandler(
  request: FastifyRequest<{ Body: CreateEventBody }>,
  reply: FastifyReply,
) {
  const {
    countryId,
    title,
    description,
    venue,
    venueAddress,
    latitude,
    longitude,
    startsAt,
    endsAt,
    imageUrl,
    ticketUrl,
    categoryIds,
  } = request.body;
  // Never trusts a client-supplied status - createEventBodySchema's
  // additionalProperties: false already silently strips one if sent. An
  // admin's own submission doesn't need to self-moderate (the same trust
  // level every other admin-gated write in this API already has); a
  // regular user's starts in the moderation queue.
  const role = await getUserRole(request.user.sub);
  const status = role === "admin" ? "approved" : "pending";
  try {
    const event = await createEvent({
      countryId,
      title,
      description: description ?? null,
      venue: venue ?? null,
      venueAddress: venueAddress ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      startsAt,
      endsAt: endsAt ?? null,
      imageUrl: imageUrl ?? null,
      ticketUrl: ticketUrl ?? null,
      status,
      categoryIds,
      createdByUserId: request.user.sub,
      // An admin's own submission is auto-approved above - that auto-
      // approval *is* the moderation decision, made by this same admin,
      // so it's recorded as one (Step 27) rather than left looking
      // unmoderated just because it happened at creation time.
      moderatedByUserId: role === "admin" ? request.user.sub : null,
    });
    return reply.status(201).send({ event });
  } catch (err) {
    if (err instanceof InvalidCountryError) {
      return badRequest(reply, "countryId does not match a known country");
    }
    if (err instanceof InvalidEndsAtError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof InvalidEventCategoryError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof InvalidLocationError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof DuplicateEventError) {
      return reply.status(409).send({ status: "error", message: err.message });
    }
    throw err;
  }
}

interface UpdateEventBody {
  countryId?: number;
  title?: string;
  description?: string;
  venue?: string;
  venueAddress?: string;
  latitude?: number;
  longitude?: number;
  startsAt?: string;
  endsAt?: string;
  imageUrl?: string;
  ticketUrl?: string;
  status?: EventStatus;
  moderationReason?: string;
  categoryIds?: number[];
}

async function updateEventHandler(
  request: FastifyRequest<{ Params: { id: number }; Body: UpdateEventBody }>,
  reply: FastifyReply,
) {
  if (request.body.moderationReason !== undefined && request.body.status === undefined) {
    return badRequest(
      reply,
      "moderationReason is only valid together with status in the same request",
    );
  }
  try {
    const event = await updateEvent(request.params.id, request.body, request.user.sub);
    if (!event) {
      return eventNotFound(reply);
    }
    return { event };
  } catch (err) {
    if (err instanceof InvalidCountryError) {
      return badRequest(reply, "countryId does not match a known country");
    }
    if (err instanceof InvalidEndsAtError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof InvalidEventCategoryError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof InvalidLocationError) {
      return badRequest(reply, err.message);
    }
    if (err instanceof DuplicateEventError) {
      return reply.status(409).send({ status: "error", message: err.message });
    }
    throw err;
  }
}

async function deleteEventHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  const deleted = await deleteEvent(request.params.id);
  if (!deleted) {
    return eventNotFound(reply);
  }
  return reply.status(204).send();
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListEventsQuery }>(
    "/events",
    {
      schema: {
        description:
          "Lists approved events. Filter with countryId and/or categoryId (see " +
          "GET /v1/event-categories), q (a case-insensitive substring match against " +
          "the event title), and/or startsAfter/startsBefore (an inclusive date-time " +
          "range against startsAt - e.g. \"what's happening this weekend\"). Excludes " +
          "an event that has already concluded by default - pass includePast=true to " +
          "see those too. nearLatitude/nearLongitude (given together) filter to events " +
          "with their own coordinates, add a distanceKm to each result, and switch the " +
          "ordering to nearest-first instead of soonest-first; radiusKm (requires both) " +
          "additionally caps how far away a result can be. Paginated " +
          `with limit (default ${DEFAULT_EVENT_LIST_LIMIT}, max ${MAX_EVENT_LIST_LIMIT}) and offset. ` +
          "Ordered soonest-first (startsAt ascending) unless a proximity search is active.",
        tags: ["events"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            countryId: { type: "integer", minimum: 1 },
            categoryId: { type: "integer", minimum: 1 },
            q: { type: "string", minLength: 1, maxLength: MAX_EVENT_SEARCH_LENGTH },
            startsAfter: { type: "string", format: "date-time" },
            startsBefore: { type: "string", format: "date-time" },
            includePast: { type: "boolean", default: false },
            nearLatitude: { type: "number", minimum: -90, maximum: 90 },
            nearLongitude: { type: "number", minimum: -180, maximum: 180 },
            radiusKm: { type: "number", exclusiveMinimum: 0, maximum: 20000 },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_EVENT_LIST_LIMIT,
              default: DEFAULT_EVENT_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              events: { type: "array", items: eventSchema },
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
            required: ["events", "pagination"],
          },
          400: errorResponseSchema,
        },
      },
    },
    listEventsHandler,
  );

  app.get<{ Querystring: AdminListEventsQuery }>(
    "/admin/events",
    {
      // Admin-only - this is the moderation queue: full visibility into
      // pending/approved/rejected submissions. Never reachable from the
      // public route above by any query param.
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Lists events with full visibility (including pending/rejected submissions) " +
          "for admin moderation. Requires an admin account. Same countryId/categoryId/q/" +
          "startsAfter/startsBefore/nearLatitude/nearLongitude/radiusKm filters as " +
          "GET /v1/events, plus status to filter to exactly one moderation state (omit " +
          "to see the full queue) and upcomingOnly to narrow to events that haven't " +
          "concluded yet (omit to see both past and upcoming - unlike the public route, " +
          "this never excludes a concluded event by default). As with the public route, " +
          "supplying nearLatitude/nearLongitude sorts results nearest-first instead of " +
          "by start time.",
        tags: ["events"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            countryId: { type: "integer", minimum: 1 },
            categoryId: { type: "integer", minimum: 1 },
            q: { type: "string", minLength: 1, maxLength: MAX_EVENT_SEARCH_LENGTH },
            startsAfter: { type: "string", format: "date-time" },
            startsBefore: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["pending", "approved", "rejected"] },
            upcomingOnly: { type: "boolean" },
            nearLatitude: { type: "number", minimum: -90, maximum: 90 },
            nearLongitude: { type: "number", minimum: -180, maximum: 180 },
            radiusKm: { type: "number", exclusiveMinimum: 0, maximum: 20000 },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_EVENT_LIST_LIMIT,
              default: DEFAULT_EVENT_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              events: { type: "array", items: eventSchema },
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
            required: ["events", "pagination"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    listAdminEventsHandler,
  );

  app.get<{ Params: { id: number } }>(
    "/events/:id",
    {
      schema: {
        description: "Returns a single approved event.",
        tags: ["events"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        response: {
          200: {
            type: "object",
            properties: { event: eventSchema },
            required: ["event"],
          },
          404: errorResponseSchema,
        },
      },
    },
    getEventHandler,
  );

  app.post<{ Body: CreateEventBody }>(
    "/events",
    {
      // Any authenticated user (not admin-only, unlike stations) - the
      // defining difference of the Events domain: submission is open, and
      // moderation happens afterward. See createEventHandler for exactly
      // how the resulting status is derived server-side from the
      // submitter's role.
      preHandler: [app.authenticate],
      // Step 58/OWASP API6 (Unrestricted Access to Sensitive Business
      // Flows): a regular user's submission lands in a human's moderation
      // queue (Step 24) - unlike most writes in this API, the cost of
      // abuse here isn't just database load, it's wasted admin review
      // time and a queue an admin can no longer trust at a glance. The
      // global 100/min limit alone would let one script flood that queue.
      // Looser than registration's 5/min (a real event organizer
      // legitimately submits more than one event per session) but a real,
      // dedicated bound rather than relying on the global limit alone.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      preValidation: (request, reply, done) => {
        trimEventBodyStrings(request.body as Partial<TrimmableEventFields> | undefined);
        done();
      },
      schema: {
        description:
          "Submits an event. Requires authentication (any account, not just admin). " +
          "A regular user's submission starts pending and is hidden from the public " +
          "listing until an admin approves it via PATCH; an admin's own submission is " +
          "approved immediately. Optional categoryIds attaches it to existing event " +
          "categories (GET /v1/event-categories). Rate-limited to 10/min. `409` if an " +
          "event with the same title already exists for this country and start time.",
        tags: ["events"],
        security: [{ bearerAuth: [] }],
        body: createEventBodySchema,
        response: {
          201: {
            type: "object",
            properties: { event: eventSchema },
            required: ["event"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    createEventHandler,
  );

  app.patch<{ Params: { id: number }; Body: UpdateEventBody }>(
    "/events/:id",
    {
      // Admin-only - this is how moderation actually happens (PATCH
      // { status: "approved" }/{ status: "rejected" }), as well as any
      // other correction to a submission. A regular user cannot edit or
      // moderate their own submission after the fact.
      preHandler: [app.authenticate, app.requireAdmin],
      preValidation: (request, reply, done) => {
        trimEventBodyStrings(request.body as Partial<TrimmableEventFields> | undefined);
        done();
      },
      schema: {
        description:
          "Updates an event, including moderating it (status: 'approved'/'rejected'). " +
          "Requires an admin account. All fields optional; only the fields present are " +
          "changed. May include an optional moderationReason (only valid together with " +
          "status) - the acting admin and a timestamp are recorded automatically " +
          "either way. categoryIds, if present, replaces the event's full set of " +
          "categories - omit to leave it untouched, send [] to clear it.",
        tags: ["events"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        body: updateEventBodySchema,
        response: {
          200: {
            type: "object",
            properties: { event: eventSchema },
            required: ["event"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    updateEventHandler,
  );

  app.delete<{ Params: { id: number } }>(
    "/events/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Permanently deletes an event. Requires an admin account. Prefer " +
          "PATCH { status: 'rejected' } to moderate a submission out of the public " +
          "listing while keeping its history - this is for removing a genuine " +
          "mistake or spam, not routine moderation.",
        tags: ["events"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        response: {
          204: { type: "null", description: "Event deleted." },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    deleteEventHandler,
  );
}
