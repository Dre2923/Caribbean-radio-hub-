import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as client from "@prometheus-io/client";
import { metricsRegistry } from "../metrics/registry.js";
import { env } from "../config/env.js";

// Constant-time comparison so a metrics-scraper credential check can't leak
// timing information about how much of a guessed token matched - the same
// defense-in-depth reasoning already applied to every other secret
// comparison in this app (password/token verification), even though the
// practical stakes here (read-only process metrics, not an account) are
// lower.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// A pure function of its two inputs (like config/env.ts's own
// resolveMetricsToken) rather than reading env/request directly - a test
// exercises every combination directly, without needing env.ts's
// load-time singleton to somehow reflect a token set mid-test.
export function isMetricsRequestAuthorized(
  authorizationHeader: string | undefined,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) {
    // Only reachable outside production - env.ts's own resolveMetricsToken
    // throws at startup if this is unset in production, so an open
    // /metrics here is a deliberate, documented local/CI convenience,
    // never a production posture.
    return true;
  }
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  return timingSafeEqual(authorizationHeader.slice("Bearer ".length), configuredToken);
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/metrics",
    {
      schema: {
        description:
          "Prometheus-format scrape endpoint (process/runtime metrics plus per-route HTTP " +
          "request duration). Unversioned, like /health - infrastructure surface for a " +
          "monitoring scraper, not API contract a client depends on. Requires " +
          "'Authorization: Bearer <METRICS_TOKEN>' in production; open in development/test.",
        tags: ["health"],
        response: {
          401: {
            type: "object",
            properties: { status: { type: "string" }, message: { type: "string" } },
            required: ["status", "message"],
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isMetricsRequestAuthorized(request.headers.authorization, env.metricsToken)) {
        return reply.status(401).send({ status: "error", message: "Unauthorized" });
      }
      reply.header("Content-Type", client.contentType);
      return metricsRegistry.metrics();
    },
  );
}
