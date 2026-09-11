import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { processPendingEmails } from "../src/email/outboxWorker.js";
import type { EmailMessage, EmailProvider } from "../src/email/types.js";

// The reset token never appears in any HTTP response - it only ever
// reaches the user via the password-reset email. These tests exercise the
// real outbox pipeline end to end (enqueue on request -> claim -> "send"),
// standing in a capturing provider for the real SMTP send, then pull the
// token out of the actual reset link the email contains - the same link a
// real user would click.
class CapturingEmailProvider implements EmailProvider {
  public readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

function extractResetToken(email: EmailMessage): string {
  const match = email.text.match(/token=([a-f0-9]+)/);
  if (!match) {
    throw new Error(`No reset token found in email text: ${email.text}`);
  }
  return match[1];
}

async function requestAndCaptureResetToken(
  app: ReturnType<typeof buildApp>,
  email: string,
): Promise<string> {
  const requestReset = await app.inject({
    method: "POST",
    url: "/auth/password-reset/request",
    payload: { email },
  });
  expect(requestReset.statusCode).toBe(200);

  // This is a real (never-truncated-between-runs) database that other
  // test files' outbox rows can also be sitting in at the same time, so a
  // claimed batch isn't guaranteed to contain only this call's email -
  // match on the recipient this test actually cares about rather than
  // assuming the batch has exactly one message in it.
  const provider = new CapturingEmailProvider();
  await processPendingEmails(provider);
  const message = provider.sent.find((m) => m.to === email);
  if (!message) {
    throw new Error(
      `No outbox email captured for ${email} (captured: ${provider.sent.map((m) => m.to).join(", ") || "none"})`,
    );
  }
  expect(message.subject).toBe("Reset your Caribbean Radio Hub password");

  return extractResetToken(message);
}

describe("password reset flow", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("resets the password, invalidates prior sessions, and the token is single-use", async () => {
    const app = buildApp();
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

    const rawResetToken = await requestAndCaptureResetToken(app, email);
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
    const email = `passwordreset-relink-${Date.now()}@example.com`;
    const password = "original-password-for-relink-test";

    await app.inject({
      method: "POST",
      url: "/users",
      payload: { email, password, displayName: "Password Reset Relink Test" },
    });

    const firstToken = await requestAndCaptureResetToken(app, email);
    const secondToken = await requestAndCaptureResetToken(app, email);

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
