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
import { stationsRoutes } from "./routes/stations.js";
import { pinoLogger } from "./utils/logger.js";
import { env } from "./config/env.js";
import { getTokenVersion, getUserRole } from "./repositories/usersRepository.js";

// Fastify's TypeScript types omit the numeric "trust N hops" form that its
// underlying proxy-addr resolution actually supports at runtime, so a
// configured hop count is turned into the equivalent function form here
// rather than casting past the type checker. (Fastify's own
// TrustProxyFunction type isn't actually exported from its namespace, so
// this mirrors its shape - (address, hop) => boolean - structurally.)
type TrustProxyFunction = (address: string, hop: number) => boolean;

// Thrown (never manually reply.send()'d - see the comment on
// app.authenticate below for why that matters) when a token's embedded
// token-version claim no longer matches the account's current one, i.e.
// the password has changed since this token was issued.
class StaleTokenError extends Error {
  statusCode = 401;
  constructor() {
    super("Token was issued before the most recent password change");
    this.name = "StaleTokenError";
  }
}

// Thrown (never manually reply.send()'d, for the identical race-free reason
// as StaleTokenError/app.authenticate above) when an authenticated request
// reaches an admin-gated route but the account's current role isn't
// 'admin'.
class ForbiddenError extends Error {
  statusCode = 403;
  constructor() {
    super("Admin access required");
    this.name = "ForbiddenError";
  }
}

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
          description:
            "Caribbean Radio & Events Platform backend (Foundation Steps 01-11, Radio " +
            "Master Catalog Steps 12+). All business-domain routes are under /v1 - " +
            "see README.md 'API versioning' for the policy.",
          version: "1.0.0",
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

    // A valid signature only proves the token was legitimately issued at
    // some point - it says nothing about whether the password has changed
    // since. `tv` is undefined for a token signed without this claim (not
    // expected in production once every login goes through the current
    // code, but true for tokens signed directly in tests) - skip rather
    // than reject, so this only tightens behavior for real sessions, never
    // breaks a token this check doesn't know how to evaluate. Likewise a
    // null currentTokenVersion (account no longer exists) is left for the
    // route handler's own lookup to turn into its usual 404, not folded
    // into this check as a 401.
    if (request.user.tv !== undefined) {
      const currentTokenVersion = await getTokenVersion(request.user.sub);
      if (currentTokenVersion !== null && currentTokenVersion !== request.user.tv) {
        throw new StaleTokenError();
      }
    }
  });

  // Always run *after* app.authenticate in a route's preHandler chain (it
  // depends on request.user, which authenticate populates) - e.g.
  // `preHandler: [app.authenticate, app.requireAdmin]`. Deliberately looks
  // the role up fresh from the database on every call rather than trusting
  // any cached/token-embedded value - see the comment on
  // usersRepository.getUserRole for why: a demoted admin must lose access
  // on their very next request, not whenever their token happens to expire.
  // Same structural race-free pattern as app.authenticate: thrown, not
  // reply.send()'d.
  app.decorate("requireAdmin", async (request) => {
    const role = await getUserRole(request.user.sub);
    if (role !== "admin") {
      throw new ForbiddenError();
    }
  });

  // Unversioned by design: load balancers, uptime monitors, and orchestrator
  // liveness/readiness probes are configured once against a fixed path and
  // are not "clients" of the business API in the sense that needs a
  // migration path - versioning them would only add churn to
  // infrastructure config for no compatibility benefit.
  app.register(healthRoutes);

  // Every business-domain route lives under /v1. This app has no shipped
  // clients yet, so a clean versioned start costs nothing now - but mobile
  // clients (Android/iOS/Windows) are a Cross-Cutting Non-Negotiable, and
  // once real installs exist in app stores, they can be stuck on an old API
  // shape for as long as a store review cycle takes. Introducing versioning
  // after that point would mean retrofitting it under live traffic instead
  // of choosing the path today. A future breaking change gets its own
  // /v2 plugin registered alongside this one, not a mutation of /v1 - see
  // README.md "API versioning".
  app.register(
    async (v1) => {
      v1.register(countriesRoutes);
      v1.register(usersRoutes);
      v1.register(authRoutes);
      v1.register(meRoutes);
      v1.register(stationsRoutes);
    },
    { prefix: "/v1" },
  );

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
