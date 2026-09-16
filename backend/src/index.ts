import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { pool } from "./db/pool.js";
import { createEmailProvider } from "./email/provider.js";
import { startEmailOutboxWorker } from "./email/outboxWorker.js";
import { startHealthCheckWorker } from "./stationHealth/healthCheckWorker.js";
import { startAutoDeactivationWorker } from "./stationHealth/autoDeactivationWorker.js";

const app = buildApp();

// The outbox worker runs independently of the HTTP server - it's what
// actually sends emails queued by request handlers (e.g. password reset).
// Started alongside the server and stopped on the same graceful-shutdown
// path so nothing leaks a dangling timer or a mid-send connection.
const stopEmailOutboxWorker = startEmailOutboxWorker(createEmailProvider());

// Likewise independent of the HTTP server - periodically checks every
// active station's own stream, the automatic counterpart to Step 19's
// manual POST /v1/admin/stations/:id/health-check.
const stopHealthCheckWorker = startHealthCheckWorker();

// Closes the loop on the health-check data the worker above collects -
// curates off any station confirmed completely unreachable for a
// sustained period, so a dead stream doesn't linger in the public catalog
// indefinitely waiting for an admin to notice.
const stopAutoDeactivationWorker = startAutoDeactivationWorker();

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
  stopHealthCheckWorker();
  stopAutoDeactivationWorker();
  // app.close() first, not pool.end() first - it drains in-flight HTTP
  // requests before resolving, and those requests still need a working
  // database connection to finish. Only once every request has actually
  // completed is it safe to close the pool. Every test file in this
  // project's own suite already calls pool.end() in its own afterAll -
  // production's shutdown path never did the same, a real, previously
  // unnoticed gap: the three background workers stopped above clear their
  // own interval timers, but that can't cancel a query one of them already
  // has in flight at the exact moment SIGTERM arrives. Without pool.end(),
  // the immediately-following process.exit() would tear down that
  // in-flight query mid-write; pool.end() instead waits for every checked-
  // out client to be returned before resolving, so a genuinely in-flight
  // query gets to finish first. (Empirically, a fully idle connection with
  // no in-flight query closes just as promptly either way once the
  // process exits - Node's own process teardown closes the socket fast
  // enough that Postgres notices immediately regardless - so this
  // specific benefit is real but only observable under that narrow race,
  // not as a general "connections linger without this" difference.)
  await app.close();
  await pool.end();
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
