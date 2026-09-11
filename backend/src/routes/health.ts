import type { FastifyInstance } from "fastify";
import { checkDatabaseConnection } from "../db/pool.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        description: "Liveness check. Always 200 if the process is running; no external dependencies.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              uptimeSeconds: { type: "number" },
            },
            required: ["status", "uptimeSeconds"],
          },
        },
      },
    },
    async () => {
      return { status: "ok", uptimeSeconds: process.uptime() };
    },
  );

  app.get(
    "/health/db",
    {
      schema: {
        description: "Readiness check. Verifies the database connection.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              database: { type: "string", enum: ["connected"] },
            },
            required: ["status", "database"],
          },
          503: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["error"] },
              database: { type: "string", enum: ["unreachable"] },
            },
            required: ["status", "database"],
          },
        },
      },
    },
    async (_request, reply) => {
      const isConnected = await checkDatabaseConnection();
      if (!isConnected) {
        return reply.status(503).send({ status: "error", database: "unreachable" });
      }
      return { status: "ok", database: "connected" };
    },
  );
}
