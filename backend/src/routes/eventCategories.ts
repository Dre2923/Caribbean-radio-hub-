import type { FastifyInstance } from "fastify";
import { listEventCategories } from "../repositories/eventCategoriesRepository.js";
import { eventCategorySchema } from "../schemas/common.js";

export async function eventCategoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/event-categories",
    {
      schema: {
        description:
          "Lists the available event categories an event can be tagged with (see " +
          "categoryIds on POST/PATCH /v1/events).",
        tags: ["events"],
        response: {
          200: {
            type: "object",
            properties: { categories: { type: "array", items: eventCategorySchema } },
            required: ["categories"],
          },
        },
      },
    },
    async () => {
      const categories = await listEventCategories();
      return { categories };
    },
  );
}
