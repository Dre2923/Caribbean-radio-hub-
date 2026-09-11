import { describe, expect, it } from "vitest";
import { parseSmtpConfig } from "../src/config/env.js";
import { buildPasswordResetEmail } from "../src/email/templates/passwordReset.js";
import { createEmailProvider } from "../src/email/provider.js";
import { ConsoleEmailProvider } from "../src/email/providers/consoleEmailProvider.js";
import { SmtpEmailProvider } from "../src/email/providers/smtpEmailProvider.js";

describe("parseSmtpConfig (SMTP_* env vars)", () => {
  it("returns undefined when SMTP_HOST is unset - no real provider configured", () => {
    expect(parseSmtpConfig({})).toBeUndefined();
  });

  it("parses a full configuration with explicit values", () => {
    const config = parseSmtpConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "apikey",
      SMTP_PASSWORD: "secret",
      EMAIL_FROM: "Caribbean Radio Hub <no-reply@example.com>",
    });

    expect(config).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "apikey",
      password: "secret",
      from: "Caribbean Radio Hub <no-reply@example.com>",
    });
  });

  it("defaults port to 587 and secure to false when unset", () => {
    const config = parseSmtpConfig({ SMTP_HOST: "smtp.example.com", EMAIL_FROM: "no-reply@example.com" });
    expect(config?.port).toBe(587);
    expect(config?.secure).toBe(false);
  });

  it("allows an unauthenticated relay - user/password default to empty strings", () => {
    const config = parseSmtpConfig({ SMTP_HOST: "smtp.internal", EMAIL_FROM: "no-reply@example.com" });
    expect(config?.user).toBe("");
    expect(config?.password).toBe("");
  });

  it("throws if SMTP_HOST is set but EMAIL_FROM is missing - a real provider needs a sender", () => {
    expect(() => parseSmtpConfig({ SMTP_HOST: "smtp.example.com" })).toThrow(/EMAIL_FROM/);
  });
});

describe("buildPasswordResetEmail", () => {
  it("includes the reset link in both the text and html bodies", () => {
    const resetUrl = "https://app.example.com/reset-password?token=abc123";
    const email = buildPasswordResetEmail("user@example.com", resetUrl);

    expect(email.to).toBe("user@example.com");
    expect(email.subject).toMatch(/reset/i);
    expect(email.text).toContain(resetUrl);
    expect(email.html).toContain(resetUrl);
  });

  it("mentions the 1-hour expiry so recipients know the link is time-limited", () => {
    const email = buildPasswordResetEmail("user@example.com", "https://app.example.com/reset");
    expect(email.text).toMatch(/1 hour/);
    expect(email.html).toMatch(/1 hour/);
  });
});

describe("createEmailProvider (SMTP vs. dev-console selection)", () => {
  it("selects the console provider when no SMTP config is given - the safe, explicit default", () => {
    expect(createEmailProvider(undefined)).toBeInstanceOf(ConsoleEmailProvider);
  });

  it("selects the SMTP provider once a real SMTP config is given", () => {
    const provider = createEmailProvider({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "apikey",
      password: "secret",
      from: "no-reply@example.com",
    });
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });
});
