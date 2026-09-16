// Step 61: Competitor Failure Test Suite (resilience/chaos testing).
// docs/ARCHITECTURE_PLAN.md scoped this step as needing the full system's
// actual failure modes to exist first - correctly last among the feature
// buckets. Much of this system's own resilience to a *dependency's*
// failure is already tested where that dependency was actually built
// (checkStreamHealth's real-server timeout/refused-connection/infinite-
// stream tests, Step 19; the email outbox's real retry-to-cap-then-
// dead-letter behavior, Step 07; FCM's own timeout protection, Step 58),
// so this file is deliberately scoped to real, previously-untested
// failure classes at the HTTP/DB layer itself, found by directly
// checking what already has coverage rather than assuming a gap exists.

import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

afterAll(async () => {
  await pool.end();
});

describe("Database connection pool under real concurrent load (Step 61)", () => {
  it("serves a burst of concurrent DB-backed requests well beyond the pool's own max (10), none dropped", async () => {
    const app = buildApp();
    await app.ready();

    // 3x the pool's configured max (db/pool.ts: max: 10) - node-postgres's
    // own documented behavior is to queue a checkout request past max
    // rather than reject it, but that's this app's own load-bearing
    // assumption about a third-party library's behavior, never directly
    // exercised against this app's real routes before this test.
    const BURST_SIZE = 30;
    const responses = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => app.inject({ method: "GET", url: "/v1/countries" })),
    );

    const statusCodes = responses.map((r) => r.statusCode);
    expect(statusCodes.every((code) => code === 200)).toBe(true);
    // Every response is real, hydrated data, not a partial/empty
    // fallback returned while starved for a connection.
    for (const response of responses) {
      expect(response.json().countries.length).toBeGreaterThan(0);
    }

    await app.close();
  });
});

describe("Malformed and oversized request bodies (Step 61)", () => {
  it("rejects syntactically invalid JSON with a clean 400, not a 500 or a hang", async () => {
    const app = buildApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { "content-type": "application/json" },
      payload: "{ this is not valid json",
    });

    expect(response.statusCode).toBe(400);
    // Never a raw parser error/stack trace leaked to the client - the
    // same "no internal detail in an error response" standard already
    // established for every other error path in this API (Step 02).
    expect(response.json()).not.toHaveProperty("stack");

    await app.close();
  });

  it("rejects a payload beyond Fastify's own body size limit with a clean error, not a crash or a hang", async () => {
    const app = buildApp();
    await app.ready();

    // No bodyLimit override exists anywhere in app.ts - confirmed
    // directly (grep) before writing this test - so Fastify's own
    // documented default (1 MiB) is what's actually in force in
    // production. A payload past it should be rejected cleanly, not
    // silently accepted, buffered without bound, or left to crash the
    // process on an out-of-memory condition under a real hostile client.
    const oversizedPayload = JSON.stringify({
      email: "oversized@example.com",
      password: "a".repeat(2 * 1024 * 1024),
      displayName: "Oversized",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { "content-type": "application/json" },
      payload: oversizedPayload,
    });

    expect(response.statusCode).toBe(413);

    await app.close();
  });
});
