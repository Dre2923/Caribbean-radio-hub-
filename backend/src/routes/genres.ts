import type { FastifyInstance } from "fastify";
import { listGenres } from "../repositories/genresRepository.js";
import { genreSchema } from "../schemas/common.js";

export async function genresRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/genres",
    {
      schema: {
        description:
          "Lists the available radio genres a station can be tagged with (see " +
          "genreIds on POST/PATCH /v1/stations).",
        tags: ["stations"],
        response: {
          200: {
            type: "object",
            properties: { genres: { type: "array", items: genreSchema } },
            required: ["genres"],
          },
        },
      },
    },
    async () => {
      const genres = await listGenres();
      return { genres };
    },
  );
}
