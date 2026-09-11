import type { FastifyInstance } from "fastify";
import { listLanguages } from "../repositories/languagesRepository.js";
import { languageSchema } from "../schemas/common.js";

export async function languagesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/languages",
    {
      schema: {
        description:
          "Lists the available languages a station can be tagged with (see " +
          "languageIds on POST/PATCH /v1/stations).",
        tags: ["stations"],
        response: {
          200: {
            type: "object",
            properties: { languages: { type: "array", items: languageSchema } },
            required: ["languages"],
          },
        },
      },
    },
    async () => {
      const languages = await listLanguages();
      return { languages };
    },
  );
}
