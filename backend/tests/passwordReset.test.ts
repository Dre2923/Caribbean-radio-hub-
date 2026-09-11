import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import * as logger from "../src/utils/logger.js";

// The reset token never appears in any HTTP response - it only ever
// reaches the caller via the (currently: logged, eventually: emailed)
// side channel - so these tests spy on the logger to get the raw token,
// the same "channel" a real email would be, rather than reaching into
// the database directly.
function captureLoggedResetToken(): { getToken: () => string } {
  let capturedToken = "";
  vi.spyOn(logger.logger, "info").mockImplementation((message: string, fields?: Record<string, unknown>) => {
    if (message.startsWith("Password reset requested") && typeof fields?.resetToken === "string") {
      capturedToken = fields.resetToken;
    }
  });
  return { getToken: () => capturedToken };
}

describe("password reset flow", () => {
  afterAll(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  it("resets the password, invalidates prior sessions, and the token is single-use", async () => {
    const app = buildApp();
    const capture = captureLoggedResetToken();
    const email = `passwordreset-${Date.now()}@example.com`;
    const originalPassword = "original-password-for-reset-test";
    const newPassword = "recovered-password-for-reset-test";

    await app.inject({
      method: "POST",
      url: "/users",
      payload: { email, password: originalPassword, displayName: "Password Reset Test" },
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: originalPassword },
    });
    const preResetToken = login.json().token as string;

    const requestReset = await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email },
    });
    expect(requestReset.statusCode).toBe(200);

    const rawResetToken = capture.getToken();
    expect(rawResetToken).toBeTruthy();

    const confirmReset = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: rawResetToken, newPassword },
    });
    expect(confirmReset.statusCode).toBe(204);

    // The old password must no longer work.
    const oldPasswordLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: originalPassword },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    // The new password must work.
    const newPasswordLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: newPassword },
    });
    expect(newPasswordLogin.statusCode).toBe(200);

    // A session token issued *before* the reset must be dead - a reset
    // triggered because of a suspected compromise should kill any
    // session an attacker might already hold, not just the password.
    const meWithPreResetToken = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${preResetToken}` },
    });
    expect(meWithPreResetToken.statusCode).toBe(401);

    // The reset token must be single-use: replaying it must fail even
    // with a syntactically valid, previously-real token.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: rawResetToken, newPassword: "should-never-apply-either" },
    });
    expect(replay.statusCode).toBe(400);

    await app.close();
  });

  it("invalidates an earlier reset token when a new one is requested for the same account", async () => {
    const app = buildApp();
    const capture = captureLoggedResetToken();
    const email = `passwordreset-relink-${Date.now()}@example.com`;
    const password = "original-password-for-relink-test";

    await app.inject({
      method: "POST",
      url: "/users",
      payload: { email, password, displayName: "Password Reset Relink Test" },
    });

    await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email },
    });
    const firstToken = capture.getToken();

    await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email },
    });
    const secondToken = capture.getToken();

    expect(secondToken).not.toBe(firstToken);

    // The first (now-stale) link must no longer work.
    const useFirst = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: firstToken, newPassword: "attempted-with-stale-link" },
    });
    expect(useFirst.statusCode).toBe(400);

    // The second (current) link must still work.
    const useSecond = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: secondToken, newPassword: "applied-with-current-link" },
    });
    expect(useSecond.statusCode).toBe(204);

    await app.close();
  });
});
