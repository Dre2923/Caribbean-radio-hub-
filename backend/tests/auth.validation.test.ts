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

  it("rejects a token signed with a different secret", async () => {
    const app = buildApp();
    await app.ready(); // app.jwt is only guaranteed once plugin registration settles
    // A JWT of the right shape but the wrong signature must be rejected,
    // not merely a malformed string.
    const forgedToken = await app.jwt.sign({ sub: 1, email: "test@example.com" });
    const tampered = forgedToken.slice(0, -1) + (forgedToken.endsWith("A") ? "B" : "A");

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${tampered}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
