import type { FastifyInstance } from "fastify";
import { checkDatabaseConnection } from "../db/pool.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok", uptimeSeconds: process.uptime() };
  });

  app.get("/health/db", async (_request, reply) => {
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) {
      return reply.status(503).send({ status: "error", database: "unreachable" });
    }
    return { status: "ok", database: "connected" };
  });
}
