import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { healthRoutes } from "./routes/health.js";
import { countriesRoutes } from "./routes/countries.js";
import { usersRoutes } from "./routes/users.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { pinoLogger } from "./utils/logger.js";
import { env } from "./config/env.js";

// Fastify's TypeScript types omit the numeric "trust N hops" form that its
// underlying proxy-addr resolution actually supports at runtime, so a
// configured hop count is turned into the equivalent function form here
// rather than casting past the type checker. (Fastify's own
// TrustProxyFunction type isn't actually exported from its namespace, so
// this mirrors its shape - (address, hop) => boolean - structurally.)
type TrustProxyFunction = (address: string, hop: number) => boolean;

export function resolveTrustProxy(
  value: boolean | number | string,
): boolean | string | TrustProxyFunction {
  return typeof value === "number" ? (_address, hop) => hop < value : value;
}

export function buildApp() {
  const app = Fastify({
    loggerInstance: pinoLogger,
    // Trust an incoming x-request-id (e.g. from a load balancer) so a
    // request can be traced across services; requestIdHeader already
    // covers that case, so genReqId only needs to cover "no header sent".
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
    // See env.ts: without this, request.ip (what rate-limiting keys on)
    // reports the TLS-terminating proxy's address for every client once
    // this is actually deployed behind one, not the real caller.
    trustProxy: resolveTrustProxy(env.trustProxy),
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

  if (env.enableApiDocs) {
    app.register(swagger, {
      openapi: {
        info: {
          title: "Caribbean Radio & Events Platform API",
          description: "Foundation backend API (Steps 01-06).",
          version: "0.1.0",
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
      },
    });
    app.register(swaggerUi, { routePrefix: "/docs" });
  }

  // Deliberately no try/catch: `reply.sent` is a getter over the raw
  // response's `writableEnded` (see node_modules/fastify/lib/reply.js) -
  // an inherently asynchronous I/O condition, not a synchronous flag. A
  // catch block that manually calls reply.send() races against that: the
  // preHandler's promise can resolve, and Fastify's "is this handled?"
  // check can run, before the write actually completes, letting the
  // protected route handler execute anyway. Found via a flaky test: the
  // /me handler ran (hit the database) despite an invalid token - a real
  // auth-bypass risk under load, not just a test flake.
  //
  // Letting jwtVerify's rejection propagate instead is structurally
  // race-free: Fastify's preHandler error branch (handle-request.js,
  // preHandlerCallbackInner) calls reply.send(err) and returns *before*
  // ever reaching the code path that would invoke the route handler - it
  // doesn't depend on reply.sent's timing at all. @fastify/jwt's own
  // errors already carry the right statusCode (401) for every failure
  // mode (missing/malformed/expired/invalid-signature), and our
  // setErrorHandler formats them into the same {status, message} shape
  // every other error uses. Verified: tests/authenticate.test.ts fires
  // 300 concurrent invalid-token requests and requires every one to be
  // 401 - it reliably failed against the old catch-and-send version and
  // passes against this one.
  app.decorate("authenticate", async (request) => {
    await request.jwtVerify();
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
    // A 4xx is an expected client mistake (bad input, missing token) - it
    // gets logged at "warn" so it doesn't page anyone or drown out real
    // failures; only a genuine 5xx (our bug, a dependency outage) is
    // "error", which is what should ever be actionable/alerted on.
    const logMethod = statusCode < 500 ? "warn" : "error";
    request.log[logMethod]({ err: error }, "Unhandled request error");

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
