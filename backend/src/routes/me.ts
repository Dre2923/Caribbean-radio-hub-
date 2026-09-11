import type { FastifyInstance } from "fastify";
import { findUserById } from "../repositories/usersRepository.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await findUserById(request.user.sub);
    if (!user) {
      // The token is valid but the account behind it is gone (e.g. deleted
      // after the token was issued).
      return reply.status(404).send({ status: "error", message: "User not found" });
    }
    return { user };
  });
}
