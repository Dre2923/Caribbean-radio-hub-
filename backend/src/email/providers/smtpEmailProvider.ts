import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailProvider } from "../types.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/**
 * SMTP works against any real provider (AWS SES, Postmark, SendGrid,
 * Mailgun, Resend, ...) without depending on that provider's proprietary
 * SDK - switching providers later is an environment-variable change
 * (SMTP_HOST/PORT/USER/PASSWORD), not new code or a new dependency.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });
    this.from = config.from;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
