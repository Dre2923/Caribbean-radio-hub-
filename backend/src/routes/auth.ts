import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword, DUMMY_PASSWORD_HASH } from "../utils/password.js";
import { findUserByEmail } from "../repositories/usersRepository.js";

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

  const token = await app.jwt.sign({ sub: user.id, email: user.email });
  return reply.send({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      countryId: user.countryId,
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
    },
    login,
  );
}
