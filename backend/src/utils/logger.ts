import pino from "pino";
import { env } from "../config/env.js";

// fast-redact paths aren't recursive - "*.password" only matches a field
// nested exactly one level deep, so both the bare and one-level-nested form
// are listed for each sensitive key to actually catch it whether a call
// site logs it at the top level (most likely for our own
// logger.info(message, fields) call shape) or nested inside a passed-in
// object. Exported so tests/logger.test.ts can verify this against a real
// pino instance rather than trusting the config is correct.
export const REDACT_CONFIG = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
    "password",
    "*.password",
    "passwordHash",
    "*.passwordHash",
    "token",
    "*.token",
  ],
  censor: "[redacted]",
};

// Single shared pino instance: passed directly to Fastify (so every
// per-request "incoming request"/"request completed" log uses this same
// config) and wrapped below for logging outside the request lifecycle
// (startup, the DB pool, process-level crash handlers). One logger, one
// level/format/redaction policy, everywhere in the app.
export const pinoLogger = pino({
  level: env.logLevel,
  redact: REDACT_CONFIG,
  transport:
    env.nodeEnv === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
});

type LogFields = Record<string, unknown>;

export const logger = {
  info: (message: string, fields?: LogFields) => pinoLogger.info(fields ?? {}, message),
  warn: (message: string, fields?: LogFields) => pinoLogger.warn(fields ?? {}, message),
  error: (message: string, fields?: LogFields) => pinoLogger.error(fields ?? {}, message),
};
