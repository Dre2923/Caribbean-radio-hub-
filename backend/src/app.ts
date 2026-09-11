import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { countriesRoutes } from "./routes/countries.js";
import { usersRoutes } from "./routes/users.js";
import { logger } from "./utils/logger.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(healthRoutes);
  app.register(countriesRoutes);
  app.register(usersRoutes);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    logger.error("Unhandled request error", {
      error: error.message,
      stack: error.stack,
      method: request.method,
      url: request.url,
    });

    // Below 500 the message comes from Fastify itself or our own route code
    // (bad JSON body, unsupported media type, etc.) and is safe to show.
    // 500s can carry raw driver/internal detail, so only a generic message
    // ever reaches the client.
    reply.status(statusCode).send({
      status: "error",
      message: statusCode < 500 ? error.message : "Internal server error",
    });
  });

  return app;
}
