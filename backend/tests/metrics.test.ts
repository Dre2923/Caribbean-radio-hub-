import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { resolveMetricsToken } from "../src/config/env.js";
import { isMetricsRequestAuthorized } from "../src/routes/metrics.js";

afterAll(async () => {
  await pool.end();
});

describe("resolveMetricsToken", () => {
  it("returns undefined outside production when no token is configured", () => {
    expect(resolveMetricsToken("development", undefined)).toBeUndefined();
    expect(resolveMetricsToken("test", undefined)).toBeUndefined();
  });

  it("returns the token when one is configured, in any environment", () => {
    expect(resolveMetricsToken("development", "abc123")).toBe("abc123");
    expect(resolveMetricsToken("production", "abc123")).toBe("abc123");
  });

  it("throws in production when no token is configured - GET /metrics must never be silently open", () => {
    expect(() => resolveMetricsToken("production", undefined)).toThrow(/METRICS_TOKEN/);
  });
});

describe("GET /metrics", () => {
  it("is open (no auth required) in the test environment", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("serves Prometheus exposition format with default process metrics", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
    // A default metric collectDefaultMetrics() always registers, proving
    // the registry is actually wired up and not just returning an empty
    // (but technically "successful") body.
    expect(response.body).toContain("process_cpu_user_seconds_total");
    await app.close();
  });

  it("records real HTTP request duration, labeled by route (not raw URL)", async () => {
    const app = buildApp();
    // A request against a real, parameterized route (:id) - the metric's
    // route label must be the templated pattern, not this literal id,
    // or every distinct id ever requested would explode into its own time
    // series.
    await app.inject({ method: "GET", url: "/v1/stations/999999999" });

    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.body).toContain("http_request_duration_seconds");
    expect(response.body).toContain('route="/v1/stations/:id"');
    expect(response.body).not.toContain("/v1/stations/999999999");
    await app.close();
  });

});

describe("isMetricsRequestAuthorized", () => {
  it("allows any request when no token is configured", () => {
    expect(isMetricsRequestAuthorized(undefined, undefined)).toBe(true);
    expect(isMetricsRequestAuthorized("Bearer anything", undefined)).toBe(true);
  });

  it("rejects a missing Authorization header once a token is configured", () => {
    expect(isMetricsRequestAuthorized(undefined, "secret-token")).toBe(false);
  });

  it("rejects a non-Bearer or wrong Authorization header", () => {
    expect(isMetricsRequestAuthorized("Basic secret-token", "secret-token")).toBe(false);
    expect(isMetricsRequestAuthorized("Bearer wrong-token", "secret-token")).toBe(false);
  });

  it("accepts the exact configured token", () => {
    expect(isMetricsRequestAuthorized("Bearer secret-token", "secret-token")).toBe(true);
  });
});
