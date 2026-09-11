import type { FastifyInstance } from "fastify";
import { hashPassword } from "../utils/password.js";
import { createUser, EmailAlreadyRegisteredError } from "../repositories/usersRepository.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface RegisterUserBody {
  email?: string;
  password?: string;
  displayName?: string;
  countryId?: number;
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterUserBody }>("/users", async (request, reply) => {
    const { email, password, displayName, countryId } = request.body ?? {};

    if (!email || !EMAIL_PATTERN.test(email)) {
      return reply.status(400).send({ status: "error", message: "A valid email is required" });
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return reply.status(400).send({
        status: "error",
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    if (!displayName || displayName.trim().length === 0) {
      return reply.status(400).send({ status: "error", message: "displayName is required" });
    }

    const passwordHash = await hashPassword(password);

    try {
      const user = await createUser({
        email: email.toLowerCase(),
        passwordHash,
        displayName: displayName.trim(),
        countryId: countryId ?? null,
      });
      return reply.status(201).send({ user });
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return reply.status(409).send({ status: "error", message: "Email already registered" });
      }
      throw err;
    }
  });
}
