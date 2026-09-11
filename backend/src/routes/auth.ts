import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "../utils/password.js";
import {
  findUserByEmail,
  updatePasswordHash,
  ensureBootstrapAdminRole,
} from "../repositories/usersRepository.js";
import {
  createPasswordResetToken,
  findValidPasswordResetToken,
  markPasswordResetTokenUsed,
} from "../repositories/passwordResetRepository.js";
import { enqueueEmail } from "../repositories/emailOutboxRepository.js";
import { buildPasswordResetEmail } from "../email/templates/passwordReset.js";
import { withTransaction } from "../db/transaction.js";
import { errorResponseSchema, userSchema } from "../schemas/common.js";
import { MIN_PASSWORD_LENGTH, passwordByteLengthError } from "../utils/userValidation.js";
import { env } from "../config/env.js";

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

  // Config-driven admin bootstrap (see env.ts parseAdminEmails): checked on
  // every login, not just once at registration, so adding an email to
  // ADMIN_EMAILS after the account already exists still takes effect the
  // next time that person logs in, without needing a re-registration or a
  // manual DB edit.
  const role = await ensureBootstrapAdminRole(user.id, user.email, env.adminEmails);

  const token = await app.jwt.sign({ sub: user.id, email: user.email, tv: user.tokenVersion });
  return reply.send({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      countryId: user.countryId,
      createdAt: user.createdAt,
      role,
    },
  });
}

const RESET_REQUESTED_MESSAGE =
  "If that email is registered, a password reset link has been sent.";

interface RequestResetBody {
  email?: string;
}

async function requestPasswordReset(
  request: FastifyRequest<{ Body: RequestResetBody }>,
  reply: FastifyReply,
) {
  const body = request.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  // Identical response regardless of whether the email is registered - the
  // same anti-enumeration reasoning as login. Timing isn't equalized as
  // precisely as login's (that used a deliberately-slow bcrypt comparison
  // as the equalizer; here "insert a row" vs "do nothing" is a much
  // smaller and noisier signal over a real network) - a conscious,
  // documented tradeoff, not an oversight, and consistent with already
  // accepting a more direct signal elsewhere (POST /users' 409 on a
  // taken email).
  if (email) {
    const user = await findUserByEmail(email);
    if (user) {
      // Token issuance and email enqueueing commit as one atomic unit: a
      // crash or error between the two can never leave a valid, usable
      // token with no email ever queued for it. The worker that actually
      // sends the email (src/email/outboxWorker.ts) runs entirely outside
      // this transaction, so a slow or down email provider can never make
      // this request hang or fail.
      await withTransaction(async (client) => {
        const rawToken = await createPasswordResetToken(client, user.id);
        const resetUrl = `${env.frontendUrl}/reset-password?token=${rawToken}`;
        await enqueueEmail(client, buildPasswordResetEmail(user.email, resetUrl));
      });
    }
  }

  return reply.send({ status: "ok", message: RESET_REQUESTED_MESSAGE });
}

interface ConfirmResetBody {
  token: string;
  newPassword: string;
}

async function confirmPasswordReset(
  request: FastifyRequest<{ Body: ConfirmResetBody }>,
  reply: FastifyReply,
) {
  const { token, newPassword } = request.body;

  const passwordError = passwordByteLengthError(newPassword);
  if (passwordError) {
    return reply.status(400).send({ status: "error", message: passwordError });
  }

  const resetToken = await findValidPasswordResetToken(token);
  if (!resetToken) {
    return reply
      .status(400)
      .send({ status: "error", message: "Invalid or expired reset token" });
  }

  const newHash = await hashPassword(newPassword);
  // updatePasswordHash also bumps token_version (Step 08), so every
  // session issued before this reset - including one an attacker who
  // triggered account takeover might already hold - stops working
  // immediately, not just the credential itself changing.
  await updatePasswordHash(resetToken.userId, newHash);
  await markPasswordResetTokenUsed(resetToken.id);

  return reply.status(204).send();
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

  app.post<{ Body: RequestResetBody }>(
    "/auth/password-reset/request",
    {
      // A mass-triggerable "send an email to this address" action is a
      // classic spam/abuse vector independent of account security, so
      // this is rate-limited as tightly as login/registration.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description:
          "Requests a password reset link for { email }. Always returns the " +
          "same 200 and message whether or not the email is registered, so " +
          "this can't be used to enumerate accounts.",
        tags: ["auth"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              message: { type: "string" },
            },
            required: ["status", "message"],
          },
        },
      },
    },
    requestPasswordReset,
  );

  app.post<{ Body: ConfirmResetBody }>(
    "/auth/password-reset/confirm",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      // Trims `token` before the schema's minLength check runs - the raw
      // token is always lowercase hex (crypto.randomBytes(...).toString
      // ("hex") in passwordResetRepository.ts), so whitespace can never be
      // a legitimate part of it. The reset link is a URL a human receives
      // by email; a client that reads it via location.search never picks
      // up stray whitespace, but one that goes through any copy/paste path
      // could. `findValidPasswordResetToken` does an exact SHA-256 match,
      // so untrimmed whitespace wouldn't corrupt data - it would just make
      // a genuinely valid token silently look invalid instead. newPassword
      // is deliberately NOT trimmed here: unlike a token, a password's
      // leading/trailing characters can be semantically real, and trimming
      // them would silently change what the user typed.
      preValidation: (request, reply, done) => {
        const body = request.body as Partial<ConfirmResetBody> | undefined;
        if (typeof body?.token === "string") {
          body.token = body.token.trim();
        }
        done();
      },
      schema: {
        description:
          "Completes a password reset with { token, newPassword }. The token " +
          "is single-use and expires after 1 hour. Also invalidates every " +
          "session issued before the reset, not just the password itself.",
        tags: ["auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token", "newPassword"],
          properties: {
            token: { type: "string", minLength: 1 },
            newPassword: { type: "string", minLength: MIN_PASSWORD_LENGTH },
          },
        },
        response: {
          204: { type: "null", description: "Password reset." },
          400: errorResponseSchema,
        },
      },
    },
    confirmPasswordReset,
  );
}
