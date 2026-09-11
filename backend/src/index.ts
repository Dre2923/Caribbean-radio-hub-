import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createEmailProvider } from "./email/provider.js";
import { startEmailOutboxWorker } from "./email/outboxWorker.js";

const app = buildApp();

// The outbox worker runs independently of the HTTP server - it's what
// actually sends emails queued by request handlers (e.g. password reset).
// Started alongside the server and stopped on the same graceful-shutdown
// path so nothing leaks a dangling timer or a mid-send connection.
const stopEmailOutboxWorker = startEmailOutboxWorker(createEmailProvider());

// Fastify's own logger already announces the listening address(es) once
// the server is up, so there's no need to log that again here.
app
  .listen({ port: env.port, host: env.host })
  .catch((err) => {
    logger.error("Failed to start server", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully`);
  stopEmailOutboxWorker();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception, shutting down", { error: err.message, stack: err.stack });
  process.exit(1);
});
