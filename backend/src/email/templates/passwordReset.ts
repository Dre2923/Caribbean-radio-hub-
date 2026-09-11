import type { EmailMessage } from "../types.js";

/**
 * Builds the password-reset email content. Kept as a pure function (no
 * I/O) so it's trivially unit-testable and has no dependency on the
 * outbox/provider machinery around it.
 */
export function buildPasswordResetEmail(to: string, resetUrl: string): EmailMessage {
  const subject = "Reset your Caribbean Radio Hub password";

  const text = [
    "We received a request to reset your Caribbean Radio Hub password.",
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 1 hour and can only be used once.",
    "",
    "If you didn't request this, you can safely ignore this email - your password will not be changed.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${subject}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
            <tr>
              <td style="background-color:#0f766e; padding:24px 32px;">
                <span style="color:#ffffff; font-size:18px; font-weight:600;">Caribbean Radio Hub</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px; font-size:20px; color:#18181b;">Reset your password</h1>
                <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:#3f3f46;">
                  We received a request to reset the password for your account. Click the
                  button below to choose a new one. This link expires in 1 hour and can
                  only be used once.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:6px; background-color:#0f766e;">
                      <a href="${resetUrl}"
                         style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px;">
                        Reset password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0; font-size:12px; line-height:1.6; color:#71717a;">
                  If the button doesn't work, copy and paste this link into your browser:<br />
                  <a href="${resetUrl}" style="color:#0f766e; word-break:break-all;">${resetUrl}</a>
                </p>
                <p style="margin:24px 0 0; font-size:12px; line-height:1.6; color:#71717a;">
                  If you didn't request this, you can safely ignore this email - your
                  password will not be changed.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to, subject, text, html };
}
