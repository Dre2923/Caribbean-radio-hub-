import type { FastifyInstance } from "fastify";
import { listActiveCountries } from "../repositories/countriesRepository.js";

export async function countriesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/countries", async () => {
    const countries = await listActiveCountries();
    return { countries };
  });
}
