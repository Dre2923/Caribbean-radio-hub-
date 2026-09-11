import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { REDACT_CONFIG } from "../src/utils/logger.js";

// Builds a real pino instance using the app's actual redact config, writing
// to an in-memory stream so the redacted output can be asserted on
// directly - a config object alone doesn't prove pino applies it the way
// we expect, particularly for fast-redact's non-recursive wildcard paths.
function loggerWithCapturedOutput() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const testLogger = pino({ redact: REDACT_CONFIG }, destination);
  return { testLogger, lines: () => lines.map((line) => JSON.parse(line)) };
}

describe("REDACT_CONFIG", () => {
  it("redacts a top-level password, passwordHash, and token", () => {
    const { testLogger, lines } = loggerWithCapturedOutput();
    testLogger.info({ password: "plaintext-pw", passwordHash: "hash", token: "jwt" }, "msg");

    const [entry] = lines();
    expect(entry.password).toBe("[redacted]");
    expect(entry.passwordHash).toBe("[redacted]");
    expect(entry.token).toBe("[redacted]");
  });

  it("redacts password and token nested one level deep", () => {
    const { testLogger, lines } = loggerWithCapturedOutput();
    testLogger.info({ user: { password: "nested-pw", token: "nested-token" } }, "msg");

    const [entry] = lines();
    expect(entry.user.password).toBe("[redacted]");
    expect(entry.user.token).toBe("[redacted]");
  });

  it("redacts the Authorization and Cookie request headers", () => {
    const { testLogger, lines } = loggerWithCapturedOutput();
    testLogger.info(
      { req: { headers: { authorization: "Bearer secret", cookie: "session=abc" } } },
      "msg",
    );

    const [entry] = lines();
    expect(entry.req.headers.authorization).toBe("[redacted]");
    expect(entry.req.headers.cookie).toBe("[redacted]");
  });

  it("does not redact unrelated fields", () => {
    const { testLogger, lines } = loggerWithCapturedOutput();
    testLogger.info({ email: "user@example.com", displayName: "Someone" }, "msg");

    const [entry] = lines();
    expect(entry.email).toBe("user@example.com");
    expect(entry.displayName).toBe("Someone");
  });
});
