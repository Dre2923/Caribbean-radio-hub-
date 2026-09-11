import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword } from "../utils/password.js";
import {
  createUser,
  EmailAlreadyRegisteredError,
  InvalidCountryError,
} from "../repositories/usersRepository.js";
import { errorResponseSchema, userSchema } from "../schemas/common.js";
import {
  MAX_EMAIL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordByteLengthError,
} from "../utils/userValidation.js";

interface RegisterUserBody {
  email: string;
  password: string;
  displayName: string;
  countryId?: number;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

async function registerUser(
  request: FastifyRequest<{ Body: RegisterUserBody }>,
  reply: FastifyReply,
) {
  // Schema validation (required fields, email format, string lengths,
  // countryId being a positive integer) has already run by this point -
  // preValidation below normalized email/displayName first. Only the
  // checks that can't be expressed as JSON Schema remain here.
  const { email, password, displayName, countryId } = request.body;

  const passwordError = passwordByteLengthError(password);
  if (passwordError) {
    return badRequest(reply, passwordError);
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
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterUserBody }>(
    "/users",
    {
      // Registration hashes a password and writes to the DB on every call,
      // so it gets a tighter limit than the general API ceiling in app.ts
      // to blunt signup spam / credential-stuffing style abuse.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Register a new user account.",
        tags: ["users"],
        body: {
          type: "object",
          // Fastify's AJV compiler runs with removeAdditional: true by
          // default, so this doesn't reject a request carrying an unknown
          // field (e.g. a stray "isAdmin") - it silently strips it before
          // the handler ever sees it. Verified in
          // tests/users.validation.test.ts rather than assumed.
          additionalProperties: false,
          required: ["email", "password", "displayName"],
          properties: {
            email: { type: "string", format: "email", maxLength: MAX_EMAIL_LENGTH },
            password: { type: "string", minLength: MIN_PASSWORD_LENGTH },
            displayName: { type: "string", minLength: 1, maxLength: MAX_DISPLAY_NAME_LENGTH },
            countryId: { type: "integer", minimum: 1 },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { user: userSchema },
            required: ["user"],
          },
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
      // Runs before schema validation, so a client sending " Test@Example.com "
      // or untrimmed whitespace around displayName still validates and
      // registers cleanly instead of failing the format check on raw input.
      preValidation: (request, reply, done) => {
        const body = request.body as Partial<RegisterUserBody> | undefined;
        if (typeof body?.email === "string") {
          body.email = body.email.trim().toLowerCase();
        }
        if (typeof body?.displayName === "string") {
          body.displayName = body.displayName.trim();
        }
        done();
      },
    },
    registerUser,
  );
}
