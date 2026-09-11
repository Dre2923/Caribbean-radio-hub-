import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("POST /users validation", () => {
  it("rejects an invalid email", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/users",
      payload: { email: "not-an-email", password: "longenough", displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a password shorter than 8 characters", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/users",
      payload: { email: "test@example.com", password: "short", displayName: "Test" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a missing displayName", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/users",
      payload: { email: "test@example.com", password: "longenough" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
