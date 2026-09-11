import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

// A JWT's signature being valid says nothing about whether the password
// has changed since it was issued - without token versioning, a stolen
// token would stay fully valid for its whole lifetime even after the
// account owner "secures their account" by changing the password. This
// exercises the real fix against a real (migrated) database, not just the
// validation-only cases the rest of the suite covers - the whole point is
// to prove a token issued before a password change stops working
// afterward, and a fresh one issued after keeps working.
describe("token invalidation on password change", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("rejects a pre-change token after a password change, and accepts a fresh one", async () => {
    const app = buildApp();
    const email = `tokenversion-${Date.now()}@example.com`;
    const originalPassword = "correct-horse-battery-original";
    const newPassword = "correct-horse-battery-changed";

    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password: originalPassword, displayName: "Token Version Test" },
    });
    expect(registerResponse.statusCode).toBe(201);

    const firstLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: originalPassword },
    });
    expect(firstLogin.statusCode).toBe(200);
    const oldToken = firstLogin.json().token as string;

    // Baseline: the token works before any password change.
    const beforeChange = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(beforeChange.statusCode).toBe(200);

    const changePassword = await app.inject({
      method: "POST",
      url: "/v1/me/password",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { currentPassword: originalPassword, newPassword },
    });
    expect(changePassword.statusCode).toBe(204);

    // The core assertion: the very token used to make the change is now
    // rejected, not just some other unrelated old token.
    const afterChange = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(afterChange.statusCode).toBe(401);
    expect(afterChange.json().message).toMatch(/password change/i);

    // A fresh login after the change must work normally - this isn't a
    // blanket "every token for this user is broken" bug.
    const secondLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: newPassword },
    });
    expect(secondLogin.statusCode).toBe(200);
    const newToken = secondLogin.json().token as string;

    const afterFreshLogin = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(afterFreshLogin.statusCode).toBe(200);

    await app.close();
  });

  it("still returns 404, not 401, for a token whose account was deleted", async () => {
    const app = buildApp();
    const email = `tokenversion-delete-${Date.now()}@example.com`;
    const password = "correct-horse-battery-delete";

    await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password, displayName: "Token Version Delete Test" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    const token = login.json().token as string;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { password },
    });
    expect(deleteResponse.statusCode).toBe(204);

    // A deleted account's token-version lookup returns null (no row left),
    // which must fall through to the route's own "user not found" 404 -
    // not get folded into the version-mismatch check as a 401.
    const afterDelete = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterDelete.statusCode).toBe(404);

    await app.close();
  });
});
