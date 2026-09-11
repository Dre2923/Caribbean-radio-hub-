import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, verifyPassword } from "../utils/password.js";
import {
  findUserById,
  findPasswordHashById,
  updateUserProfile,
  updatePasswordHash,
  deleteUser,
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

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ status: "error", message });
}

interface UpdateProfileBody {
  email?: string;
  displayName?: string;
  countryId?: number | null;
}

async function updateProfile(
  request: FastifyRequest<{ Body: UpdateProfileBody }>,
  reply: FastifyReply,
) {
  const { email, displayName, countryId } = request.body;

  try {
    const user = await updateUserProfile(request.user.sub, { email, displayName, countryId });
    if (!user) {
      // The token is valid but the account behind it is gone (e.g. deleted
      // from another session/device between issuing the token and this call).
      return reply.status(404).send({ status: "error", message: "User not found" });
    }
    return { user };
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

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

async function changePassword(
  request: FastifyRequest<{ Body: ChangePasswordBody }>,
  reply: FastifyReply,
) {
  const currentPassword = typeof request.body?.currentPassword === "string"
    ? request.body.currentPassword
    : "";
  const newPassword = typeof request.body?.newPassword === "string"
    ? request.body.newPassword
    : "";

  if (!currentPassword || !newPassword) {
    return badRequest(reply, "currentPassword and newPassword are required");
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return badRequest(reply, `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const passwordError = passwordByteLengthError(newPassword);
  if (passwordError) {
    return badRequest(reply, passwordError.replace("Password", "newPassword"));
  }

  const currentHash = await findPasswordHashById(request.user.sub);
  if (!currentHash) {
    return reply.status(404).send({ status: "error", message: "User not found" });
  }

  // A stolen/shared-device JWT alone shouldn't be enough to lock the real
  // owner out - changing the password requires proving the current one
  // too, the same defense-in-depth reasoning as re-authenticating for a
  // sensitive action.
  const isCurrentPasswordValid = await verifyPassword(currentPassword, currentHash);
  if (!isCurrentPasswordValid) {
    return reply.status(401).send({ status: "error", message: "Current password is incorrect" });
  }

  const newHash = await hashPassword(newPassword);
  await updatePasswordHash(request.user.sub, newHash);
  return reply.status(204).send();
}

interface DeleteAccountBody {
  password?: string;
}

async function deleteAccount(
  request: FastifyRequest<{ Body: DeleteAccountBody }>,
  reply: FastifyReply,
) {
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!password) {
    return badRequest(reply, "password is required to delete your account");
  }

  const currentHash = await findPasswordHashById(request.user.sub);
  if (!currentHash) {
    return reply.status(404).send({ status: "error", message: "User not found" });
  }

  const isPasswordValid = await verifyPassword(password, currentHash);
  if (!isPasswordValid) {
    return reply.status(401).send({ status: "error", message: "Password is incorrect" });
  }

  await deleteUser(request.user.sub);
  return reply.status(204).send();
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        description: "Returns the authenticated user's profile.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: { user: userSchema },
            required: ["user"],
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await findUserById(request.user.sub);
      if (!user) {
        // The token is valid but the account behind it is gone (e.g. deleted
        // after the token was issued).
        return reply.status(404).send({ status: "error", message: "User not found" });
      }
      return { user };
    },
  );

  app.patch<{ Body: UpdateProfileBody }>(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        description:
          "Updates the authenticated user's profile. All fields optional; only " +
          "the fields present are changed. Password changes go through " +
          "POST /me/password instead, since that needs current-password " +
          "confirmation.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            email: { type: "string", format: "email", maxLength: MAX_EMAIL_LENGTH },
            displayName: { type: "string", minLength: 1, maxLength: MAX_DISPLAY_NAME_LENGTH },
            countryId: { type: "integer", minimum: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { user: userSchema },
            required: ["user"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
      preValidation: (request, reply, done) => {
        const body = request.body as Partial<UpdateProfileBody> | undefined;
        if (typeof body?.email === "string") {
          body.email = body.email.trim().toLowerCase();
        }
        if (typeof body?.displayName === "string") {
          body.displayName = body.displayName.trim();
        }
        done();
      },
    },
    updateProfile,
  );

  app.post<{ Body: ChangePasswordBody }>(
    "/me/password",
    {
      preHandler: app.authenticate,
      // Same reasoning as registration/login: a password-hashing, DB-writing
      // route that's also a prime target for abuse (an attacker with a
      // stolen token trying to lock the real owner out) gets a tight limit.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Changes the authenticated user's password. Requires the current password.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        response: {
          204: { type: "null", description: "Password changed." },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    changePassword,
  );

  app.delete<{ Body: DeleteAccountBody }>(
    "/me",
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Permanently deletes the authenticated user's account. Requires the password.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        response: {
          204: { type: "null", description: "Account deleted." },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    deleteAccount,
  );
}
