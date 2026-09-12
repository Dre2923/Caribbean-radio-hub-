import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findUserById } from "../repositories/usersRepository.js";
import { resolveVoiceCommand } from "../voice/commandResolver.js";
import { errorResponseSchema } from "../schemas/common.js";
import { voiceCommandBodySchema, voiceCommandResponseSchema } from "../schemas/voice.js";

interface VoiceCommandBody {
  text: string;
}

async function voiceCommandHandler(
  request: FastifyRequest<{ Body: VoiceCommandBody }>,
  reply: FastifyReply,
) {
  // The requester's own profile country personalizes a genre-only command
  // ("play reggae" implicitly means "in my country") - see
  // commandResolver.ts's VoiceCommandContext. A deleted-account edge case
  // (a valid token whose account is gone) simply falls back to no default
  // country rather than a 404 - the exact same "still functions, just
  // without personalization" posture already established for a stale
  // token's non-fatal edge cases elsewhere in this build.
  const user = await findUserById(request.user.sub);
  const result = await resolveVoiceCommand(request.body.text, {
    defaultCountryId: user?.countryId ?? null,
  });
  // This endpoint deliberately never returns a non-2xx status for a
  // command it merely failed to understand (not_found/ambiguous/
  // unrecognized are all 200s - see this route's own description below),
  // so the standard HTTP access log's status code can never surface a
  // command-grammar coverage gap the way it would for almost every other
  // endpoint in this API. Logging the resolved `intent` explicitly (never
  // the raw transcribed `text` - that's user-generated speech content,
  // not something to casually persist into logs by default) is what
  // actually makes "what fraction of real commands go unrecognized"
  // observable at all, through the same shared, request-id-correlated
  // Pino logger every other request already flows through (Step 04).
  request.log.info({ intent: result.intent }, "voice command resolved");
  return reply.send(result);
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: VoiceCommandBody }>(
    "/voice/command",
    {
      // Requires authentication (any account) - not because the resolved
      // intents are sensitive, but because personalizing a genre-only
      // command to "my country" requires knowing who's asking, the same
      // reasoning GET /v1/me itself is auth-gated for.
      preHandler: [app.authenticate],
      // Tighter than the API's global 100/min (app.ts): the resolver behind
      // this route can run up to four real database queries per call
      // (countries, genres/categories, station/event search, then the
      // ranking or listing query itself) - the most query-heavy single
      // endpoint in this API - and, unlike a login/registration attempt,
      // there's no inherent cap on how many distinct phrases an abusive
      // script could throw at it. 30/min is still generous for genuine
      // conversational use (one command every two seconds) while blunting
      // that amplification.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description:
          "Resolves a transcribed voice command into a structured intent. The client " +
          "performs speech-to-text on-device (see docs/ARCHITECTURE_PLAN.md) and sends " +
          "only the resulting text - no audio ever reaches this endpoint. Requires " +
          "authentication so a genre-only command ('play reggae') can default to the " +
          "caller's own profile country; a command that already names one ('play reggae " +
          "in Jamaica') doesn't need it. Never fails on unrecognized input - always " +
          "returns 200 with intent: 'unrecognized'/'not_found'/'ambiguous' and a " +
          "human-readable message instead.",
        tags: ["voice"],
        security: [{ bearerAuth: [] }],
        body: voiceCommandBodySchema,
        response: {
          200: voiceCommandResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    voiceCommandHandler,
  );
}
