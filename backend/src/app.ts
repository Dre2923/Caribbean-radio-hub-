import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import { healthRoutes } from "./routes/health.js";
import { countriesRoutes } from "./routes/countries.js";
import { usersRoutes } from "./routes/users.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { pinoLogger } from "./utils/logger.js";
import { env } from "./config/env.js";

export function buildApp() {
  const app = Fastify({
    loggerInstance: pinoLogger,
    // Trust an incoming x-request-id (e.g. from a load balancer) so a
    // request can be traced across services; requestIdHeader already
    // covers that case, so genReqId only needs to cover "no header sent".
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Echo the request id back so a client (or whoever's debugging with them)
  // can hand it over and it's immediately findable in the logs.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.register(helmet);
  app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  app.register(jwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.jwtExpiresIn },
  });

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ status: "error", message: "Invalid or missing authentication token" });
    }
  });

  app.register(healthRoutes);
  app.register(countriesRoutes);
  app.register(usersRoutes);
  app.register(authRoutes);
  app.register(meRoutes);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    // request.log carries the same reqId as the request/response log lines
    // Fastify already emits, so this error can be found alongside them.
    request.log.error({ err: error }, "Unhandled request error");

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
