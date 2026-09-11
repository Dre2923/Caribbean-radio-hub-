import type { FastifyInstance } from "fastify";
import { listActiveCountries } from "../repositories/countriesRepository.js";
import { countrySchema } from "../schemas/common.js";

export async function countriesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/countries",
    {
      schema: {
        description: "List the active launch countries.",
        tags: ["countries"],
        response: {
          200: {
            type: "object",
            properties: { countries: { type: "array", items: countrySchema } },
            required: ["countries"],
          },
        },
      },
    },
    async () => {
      const countries = await listActiveCountries();
      return { countries };
    },
  );
}
