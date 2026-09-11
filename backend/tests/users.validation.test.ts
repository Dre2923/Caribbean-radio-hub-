import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("POST /users validation", () => {
  it("rejects an invalid email", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "not-an-email", password: "longenough", displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a password shorter than 8 characters", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "test@example.com", password: "short", displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a missing displayName", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "test@example.com", password: "longenough" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a password longer than bcrypt's 72-byte limit", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "test@example.com", password: "a".repeat(73), displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a password over the byte limit even with a multi-byte character near the boundary", async () => {
    const app = buildApp();
    // 71 ascii chars + one 3-byte character = 74 bytes, but only 72 in .length
    const password = "a".repeat(71) + "☃";
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "test@example.com", password, displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-integer countryId", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: {
        email: "test@example.com",
        password: "longenough",
        displayName: "Test",
        countryId: "not-a-number",
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a displayName longer than the column limit", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email: "test@example.com", password: "longenough", displayName: "a".repeat(121) },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
