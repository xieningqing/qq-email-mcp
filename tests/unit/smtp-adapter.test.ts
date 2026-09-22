import { describe, expect, it } from "vitest";
import type { Transporter } from "nodemailer";
import {
  SmtpAdapter,
  smtpErrorToAppError
} from "../../src/adapters/smtp-adapter.js";

function adapterWith(
  transporter: Partial<Transporter>
): SmtpAdapter {
  return new SmtpAdapter({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: "me@qq.com",
    password: "auth-code",
    transporter: transporter as Transporter
  });
}

describe("smtpErrorToAppError", () => {
  it("marks send timeouts as non-retryable because delivery state is unknown", () => {
    const error = smtpErrorToAppError(
      Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" })
    );

    expect(error).toMatchObject({
      code: "TIMEOUT",
      retryable: false
    });
    expect(error.message).toContain("sending state is unknown");
  });

  it("classifies authentication failures without retrying", () => {
    const error = smtpErrorToAppError(
      Object.assign(new Error("auth failed"), { code: "EAUTH" })
    );

    expect(error).toMatchObject({
      code: "AUTH_FAILED",
      retryable: false
    });
  });
});

describe("SmtpAdapter", () => {
  it("sends through the envelope and maps accepted and rejected recipients", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = adapterWith({
      async sendMail(options: Record<string, unknown>) {
        captured = options;
        return {
          messageId: "message-id",
          accepted: ["to@example.com"],
          rejected: ["bad@example.com"],
          response: "250 OK"
        };
      }
    } as Partial<Transporter>);

    const result = await adapter.send({
      from: "me@qq.com",
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Hello",
      text: "Body"
    });

    expect(captured).toMatchObject({
      envelope: {
        from: "me@qq.com",
        to: ["to@example.com", "cc@example.com", "bcc@example.com"]
      }
    });
    expect(Buffer.isBuffer(captured?.raw)).toBe(true);
    expect(result).toMatchObject({
      messageId: "message-id",
      accepted: ["to@example.com"],
      rejected: ["bad@example.com"],
      response: "250 OK"
    });
  });

  it("verifies the transport and closes it", async () => {
    let verified = false;
    let closed = false;
    const adapter = adapterWith({
      async verify() {
        verified = true;
      },
      close() {
        closed = true;
      }
    } as Partial<Transporter>);

    await adapter.verify();
    adapter.close();

    expect(verified).toBe(true);
    expect(closed).toBe(true);
  });

  it("maps verify failures through the shared error classifier", async () => {
    const adapter = adapterWith({
      async verify() {
        throw Object.assign(new Error("auth failed"), { code: "EAUTH" });
      }
    } as Partial<Transporter>);

    await expect(adapter.verify()).rejects.toMatchObject({
      code: "AUTH_FAILED",
      retryable: false
    });
  });
});
