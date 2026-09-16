import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword } from "../utils/password.js";
import {
  createUser,
  ensureBootstrapAdminRole,
  findUserById,
  listUsers,
  setUserRole,
  DEFAULT_USER_LIST_LIMIT,
  MAX_USER_LIST_LIMIT,
  EmailAlreadyRegisteredError,
  InvalidCountryError,
  LastAdminError,
  type UserRole,
} from "../repositories/usersRepository.js";
import { errorResponseSchema, idSchema, userSchema } from "../schemas/common.js";
import { MAX_USER_SEARCH_LENGTH, USER_ROLES } from "../schemas/users.js";
import {
  MAX_EMAIL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordByteLengthError,
} from "../utils/userValidation.js";
import { env } from "../config/env.js";

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
    // Applies the same config-driven admin bootstrap as login (see
    // ensureBootstrapAdminRole) so an allowlisted email is admin from the
    // very first response, not only after a subsequent login.
    const role = await ensureBootstrapAdminRole(user.id, user.email, env.adminEmails);
    // Re-fetched rather than `{ ...user, role }`: a bootstrap promotion
    // also writes roleChangedAt/roleChangedByUserId (see
    // usersRepository.setUserRole), which the just-created `user` object
    // predates - only a fresh read reflects all three consistently.
    const currentUser = role === user.role ? user : ((await findUserById(user.id)) ?? user);
    return reply.status(201).send({ user: currentUser });
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

interface AdminListUsersQuery {
  q?: string;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

async function listAdminUsersHandler(
  request: FastifyRequest<{ Querystring: AdminListUsersQuery }>,
  reply: FastifyReply,
) {
  const { q, role, limit, offset } = request.query;
  const { users, total } = await listUsers({ search: q, role, limit, offset });
  return reply.send({
    users,
    pagination: { total, limit: limit ?? DEFAULT_USER_LIST_LIMIT, offset: offset ?? 0 },
  });
}

async function getAdminUserHandler(
  request: FastifyRequest<{ Params: { id: number } }>,
  reply: FastifyReply,
) {
  const user = await findUserById(request.params.id);
  if (!user) {
    return reply.status(404).send({ status: "error", message: "User not found" });
  }
  return reply.send({ user });
}

interface UpdateUserRoleBody {
  role: UserRole;
}

async function updateAdminUserRoleHandler(
  request: FastifyRequest<{ Params: { id: number }; Body: UpdateUserRoleBody }>,
  reply: FastifyReply,
) {
  try {
    const user = await setUserRole(request.params.id, request.body.role, request.user.sub);
    if (!user) {
      return reply.status(404).send({ status: "error", message: "User not found" });
    }
    return reply.send({ user });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return reply.status(409).send({ status: "error", message: err.message });
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
            countryId: idSchema,
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

  app.get<{ Querystring: AdminListUsersQuery }>(
    "/admin/users",
    {
      // Admin-only - the one real gap docs/ARCHITECTURE_PLAN.md's Steps
      // 27-64 research found: before this, setUserRole/getUserRole existed
      // only as repository functions reachable solely through the
      // ADMIN_EMAILS bootstrap allowlist (Step 11), with no API surface for
      // a human admin to list accounts or manage roles at all.
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Lists user accounts for admin management. Requires an admin account. " +
          "Optional ?q= (case-insensitive substring match against email or " +
          "displayName) and ?role= (narrow to exactly 'user' or 'admin' - omit to " +
          "see every account regardless of role).",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", minLength: 1, maxLength: MAX_USER_SEARCH_LENGTH },
            role: { type: "string", enum: [...USER_ROLES] },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_USER_LIST_LIMIT,
              default: DEFAULT_USER_LIST_LIMIT,
            },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              users: { type: "array", items: userSchema },
              pagination: {
                type: "object",
                properties: {
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                },
                required: ["total", "limit", "offset"],
              },
            },
            required: ["users", "pagination"],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    listAdminUsersHandler,
  );

  app.get<{ Params: { id: number } }>(
    "/admin/users/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description: "Returns a single user account. Requires an admin account.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        response: {
          200: {
            type: "object",
            properties: { user: userSchema },
            required: ["user"],
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    getAdminUserHandler,
  );

  app.patch<{ Params: { id: number }; Body: UpdateUserRoleBody }>(
    "/admin/users/:id",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: {
        description:
          "Changes a user's role. Requires an admin account. The only path to " +
          "'admin' besides the ADMIN_EMAILS bootstrap allowlist (see 'Authorization: " +
          "user roles' in the README). Rejected with 409 if this would demote the " +
          "last remaining admin - including an admin demoting themselves - since " +
          "there would then be no admin account left to reverse it.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["role"],
          properties: {
            role: { type: "string", enum: [...USER_ROLES] },
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
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    updateAdminUserRoleHandler,
  );
}
