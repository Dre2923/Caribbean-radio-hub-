import type { FastifyInstance, FastifyRequest } from "fastify";
import { getRankedStationsForCountry } from "../repositories/stationRankingRepository.js";
import { DEFAULT_RELIABILITY_WINDOW_HOURS } from "../repositories/stationHealthRepository.js";
import { errorResponseSchema } from "../schemas/common.js";
import { rankedStationSchema } from "../schemas/stationHealth.js";

const DEFAULT_RANKED_LIMIT = 20;
const MAX_RANKED_LIMIT = 50;
const MAX_RANKING_WINDOW_HOURS = 168;

interface RankedStationsQuery {
  countryId: number;
  windowHours?: number;
  limit?: number;
}

async function listRankedStationsHandler(
  request: FastifyRequest<{ Querystring: RankedStationsQuery }>,
) {
  const { countryId, windowHours, limit } = request.query;
  const ranked = await getRankedStationsForCountry(countryId, windowHours);
  const capped = ranked.slice(0, limit ?? DEFAULT_RANKED_LIMIT);
  return { stations: capped };
}

export async function stationRankingRoutes(app: FastifyInstance): Promise<void> {
  // A static path, not /stations/:id/ranked or similar - Fastify's router
  // (find-my-way) always prefers an exact static match over a parametric
  // one at the same depth, so this can never be shadowed by nor shadow
  // GET /stations/:id, confirmed live (see backend/README.md "Per-country
  // ranking (Step 22)") rather than assumed safe from routing theory alone.
  app.get<{ Querystring: RankedStationsQuery }>(
    "/stations/ranked",
    {
      schema: {
        description:
          "Returns a country's active stations ranked best-first by recent streaming " +
          "reliability - the automatic fallback chain: a client should try stations[0], " +
          "and fall through to the next entry if it fails to play. Public, no auth. " +
          `Ranking window defaults to ${DEFAULT_RELIABILITY_WINDOW_HOURS}h ("that day's" ` +
          "signal); a station with no recorded checks yet ranks after every station with " +
          "a real (even mediocre) measured track record, never ahead of one.",
        tags: ["stream-reliability"],
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["countryId"],
          properties: {
            countryId: { type: "integer", minimum: 1 },
            windowHours: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RANKING_WINDOW_HOURS,
              default: DEFAULT_RELIABILITY_WINDOW_HOURS,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RANKED_LIMIT,
              default: DEFAULT_RANKED_LIMIT,
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              stations: { type: "array", items: rankedStationSchema },
            },
            required: ["stations"],
          },
          400: errorResponseSchema,
        },
      },
    },
    listRankedStationsHandler,
  );
}
