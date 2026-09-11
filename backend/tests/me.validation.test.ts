import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("PATCH /me validation", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/me",
      payload: { displayName: "New Name" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an empty body", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid email format", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a displayName longer than the column limit", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "a".repeat(121) },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /me/password validation", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/me/password",
      payload: { currentPassword: "a", newPassword: "longenough" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a missing currentPassword", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/me/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: "longenough" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a newPassword shorter than 8 characters", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/me/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "whatever123", newPassword: "short" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a newPassword over bcrypt's 72-byte limit", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/me/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "whatever123", newPassword: "a".repeat(73) },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /me validation", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "DELETE", url: "/me" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a missing password", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "DELETE",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
