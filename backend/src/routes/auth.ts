import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword, DUMMY_PASSWORD_HASH } from "../utils/password.js";
import { findUserByEmail } from "../repositories/usersRepository.js";
import { errorResponseSchema, userSchema } from "../schemas/common.js";

interface LoginBody {
  email?: string;
  password?: string;
}

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ status: "error", message: INVALID_CREDENTIALS_MESSAGE });
}

async function login(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply,
) {
  const app = request.server;
  const body = request.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return unauthorized(reply);
  }

  const user = await findUserByEmail(email);

  // Always run a bcrypt comparison, even for an unknown email, so the
  // response time doesn't reveal whether the address is registered.
  const isValid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !isValid) {
    return unauthorized(reply);
  }

  const token = await app.jwt.sign({ sub: user.id, email: user.email, tv: user.tokenVersion });
  return reply.send({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      countryId: user.countryId,
      createdAt: user.createdAt,
    },
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      // Login is the highest-value brute-force target in the API, so it
      // gets the tightest limit of any route.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description:
          "Log in with { email, password } (JSON body). Deliberately has no " +
          "formal request-body schema: a schema-validation failure would " +
          "return a different status/message than a wrong password, which " +
          "would let an attacker distinguish 'malformed request' from " +
          "'wrong credentials' and chip away at email enumeration. Every " +
          "invalid input - missing field, wrong type, unknown email, wrong " +
          "password - returns the same 401 and message below.",
        tags: ["auth"],
        response: {
          200: {
            type: "object",
            properties: { token: { type: "string" }, user: userSchema },
            required: ["token", "user"],
          },
          401: errorResponseSchema,
        },
      },
    },
    login,
  );
}
