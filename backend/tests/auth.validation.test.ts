import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("POST /auth/login validation", () => {
  it("rejects a missing email", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "whatever123" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ status: "error", message: "Invalid email or password" });
    await app.close();
  });

  it("rejects a missing password", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "test@example.com" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /me", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a request with a garbage token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  // A tampered-signature case (valid JWT shape, wrong signature) is covered
  // by tests/authenticate.test.ts, including the race-condition regression
  // this uncovered - not duplicated here.
});
