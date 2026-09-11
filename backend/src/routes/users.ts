import type { FastifyInstance, FastifyReply } from "fastify";
import { hashPassword } from "../utils/password.js";
import {
  createUser,
  EmailAlreadyRegisteredError,
  InvalidCountryError,
} from "../repositories/usersRepository.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const MIN_PASSWORD_LENGTH = 8;
// bcrypt silently ignores any bytes beyond 72 - without a cap, two different
// passwords sharing that prefix would hash identically. Reject before that
// point rather than truncate.
const MAX_PASSWORD_LENGTH = 72;
const MAX_DISPLAY_NAME_LENGTH = 120; // matches the users.display_name column

interface RegisterUserBody {
  email?: string;
  password?: string;
  displayName?: string;
  countryId?: number;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterUserBody }>("/users", async (request, reply) => {
    const body = request.body ?? {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const { countryId } = body;

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return badRequest(reply, "A valid email is required");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(reply, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_LENGTH) {
      return badRequest(reply, `Password must be at most ${MAX_PASSWORD_LENGTH} bytes`);
    }
    if (!displayName) {
      return badRequest(reply, "displayName is required");
    }
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return badRequest(reply, `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
    }
    if (countryId !== undefined && (!Number.isInteger(countryId) || countryId <= 0)) {
      return badRequest(reply, "countryId must be a positive integer");
    }

    const passwordHash = await hashPassword(password);

    try {
      const user = await createUser({
        email,
        passwordHash,
        displayName,
        countryId: countryId ?? null,
      });
      return reply.status(201).send({ user });
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return reply.status(409).send({ status: "error", message: "Email already registered" });
      }
      if (err instanceof InvalidCountryError) {
        return badRequest(reply, "countryId does not match a known country");
      }
      throw err;
    }
  });
}
