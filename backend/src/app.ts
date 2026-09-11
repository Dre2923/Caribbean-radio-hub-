import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { countriesRoutes } from "./routes/countries.js";
import { usersRoutes } from "./routes/users.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(healthRoutes);
  app.register(countriesRoutes);
  app.register(usersRoutes);

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      status: "error",
      message: error.message,
    });
  });

  return app;
}
