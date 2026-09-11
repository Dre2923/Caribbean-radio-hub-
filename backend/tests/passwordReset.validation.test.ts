import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("POST /auth/password-reset/request validation", () => {
  it("returns the same generic 200 for a missing email", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    await app.close();
  });

  it("returns the same generic 200 for an obviously fake email", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email: "not-a-real-email-at-all" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    await app.close();
  });
});

describe("POST /auth/password-reset/confirm validation", () => {
  it("rejects a missing token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { newPassword: "longenough123" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a missing newPassword", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: "some-token-value" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a newPassword shorter than 8 characters", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: "some-token-value", newPassword: "short" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an unknown token with a generic message (no whether-it-existed leak)", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: "definitely-not-a-real-token", newPassword: "longenough123" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid or expired reset token");
    await app.close();
  });
});
