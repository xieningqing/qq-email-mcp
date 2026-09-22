import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { AppError, networkFailureKind } from "../errors.js";

export interface OutgoingAttachment {
  filename: string;
  contentType?: string | undefined;
  content: Buffer;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  replyTo?: string[] | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments?: OutgoingAttachment[] | undefined;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
  raw: Buffer;
}

export interface SmtpAdapterOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  transporter?: Transporter | undefined;
}

export interface SmtpPort {
  verify(): Promise<void>;
  compile(message: OutgoingMessage): Promise<Buffer>;
  send(message: OutgoingMessage, raw?: Buffer): Promise<SendResult>;
  close(): void;
}

function toMailOptions(message: OutgoingMessage): Mail.Options {
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content
    })),
    disableFileAccess: true,
    disableUrlAccess: true
  };
}

export function smtpErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const candidate = error as { code?: string; responseCode?: number };
  if (
    candidate.code === "EAUTH" ||
    candidate.responseCode === 535 ||
    candidate.responseCode === 530
  ) {
    return new AppError("AUTH_FAILED", "QQ Mail SMTP authentication failed", {
      cause: error
    });
  }

  if (candidate.code === "ETIMEDOUT" || candidate.code === "ESOCKET") {
    return new AppError("TIMEOUT", "QQ Mail SMTP request timed out; sending state is unknown", {
      retryable: false,
      cause: error
    });
  }

  return new AppError("SMTP_SEND_FAILED", "Unable to send the message", {
    details: candidate.code
      ? {
          code: candidate.code,
          kind: networkFailureKind(candidate.code)
        }
      : undefined,
    cause: error
  });
}

export class SmtpAdapter implements SmtpPort {
  private readonly transporter: Transporter;

  constructor(options: SmtpAdapterOptions) {
    this.transporter =
      options.transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: {
          user: options.user,
          pass: options.password
        },
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 120_000,
        disableFileAccess: true,
        disableUrlAccess: true
      });
  }

  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (error) {
      throw smtpErrorToAppError(error);
    }
  }

  async compile(message: OutgoingMessage): Promise<Buffer> {
    const options = toMailOptions(message);
    const composer = new MailComposer(options);
    return await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((error, data) => {
        if (error) {
          reject(smtpErrorToAppError(error));
          return;
        }

        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
    });
  }

  async send(message: OutgoingMessage, raw?: Buffer): Promise<SendResult> {
    try {
      const content = raw ?? (await this.compile(message));
      const info = await this.transporter.sendMail({
        envelope: {
          from: message.from,
          to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]
        },
        raw: content
      });

      return {
        messageId: info.messageId,
        accepted: info.accepted.map(String),
        rejected: info.rejected.map(String),
        response: info.response,
        raw: content
      };
    } catch (error) {
      throw smtpErrorToAppError(error);
    }
  }

  close(): void {
    this.transporter.close();
  }
}

export function outgoingFingerprint(message: OutgoingMessage): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        bcc: message.bcc ?? [],
        replyTo: message.replyTo ?? [],
        subject: message.subject,
        text: message.text,
        html: message.html ?? null,
        inReplyTo: message.inReplyTo ?? null,
        references: message.references ?? [],
        attachments: message.attachments?.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType ?? null,
          sha256: createHash("sha256").update(attachment.content).digest("hex")
        }))
      })
    )
    .digest("hex");
}
