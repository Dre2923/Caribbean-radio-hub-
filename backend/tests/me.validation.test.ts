import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

afterAll(async () => {
  await pool.end();
});

let createdUserIds: number[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number; email: string; password: string }> {
  const email = `me-validation-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "me-validation-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Me Validation User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId, email, password };
}

describe("PATCH /me validation", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me",
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
      url: "/v1/me",
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
      url: "/v1/me",
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
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "a".repeat(121) },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

// Step 59 (OWASP API2:2023, Broken Authentication): changing the
// account's own email is a sensitive operation (it's the destination a
// password reset gets sent to) and now requires re-proving the current
// password in the same request, the identical pattern POST /me/password
// and DELETE /me already establish - a stolen/leaked JWT alone should
// never be enough to redirect an account's recovery email.
describe("PATCH /me - email change requires currentPassword (Step 59, OWASP API2)", () => {
  it("changes displayName/countryId with no currentPassword required - only email is sensitive", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "non-sensitive");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { displayName: "Updated Name" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.displayName).toBe("Updated Name");

    await app.close();
  });

  it("rejects an email change with no currentPassword, with 400", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "email-no-password");
    const newEmail = `changed-${Date.now()}@example.com`;

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { email: newEmail },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("rejects an email change with the wrong currentPassword, with 401, and does not change the email", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "email-wrong-password");
    const newEmail = `changed-${Date.now()}@example.com`;

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { email: newEmail, currentPassword: "definitely-wrong-password" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json().user.email).not.toBe(newEmail);

    await app.close();
  });

  it("changes email successfully when currentPassword is correct", async () => {
    const app = buildApp();
    const { token, password } = await createRegularAccount(app, "email-success");
    const newEmail = `changed-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { email: newEmail, currentPassword: password },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(newEmail);

    await app.close();
  });
});

describe("POST /me/password validation", () => {
  it("rejects a request with no token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/me/password",
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
      url: "/v1/me/password",
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
      url: "/v1/me/password",
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
      url: "/v1/me/password",
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
    const response = await app.inject({ method: "DELETE", url: "/v1/me" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a missing password", async () => {
    const app = buildApp();
    await app.ready();
    const token = await app.jwt.sign({ sub: 1, email: "test@example.com" });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
