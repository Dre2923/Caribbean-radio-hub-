import "fastify";
import "@fastify/jwt";

export interface AuthTokenPayload {
  sub: number;
  email: string;
  // Optional (not just at the type level - genuinely absent on tokens
  // signed before this existed, and in tests that don't set it) so
  // app.authenticate can tell "no version claim, skip the check" apart
  // from "claim present and stale, reject." See app.ts for the check.
  tv?: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
