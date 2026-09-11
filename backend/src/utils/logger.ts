import { env } from "../config/env.js";

type LogFields = Record<string, unknown>;

function log(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    env: env.nodeEnv,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
