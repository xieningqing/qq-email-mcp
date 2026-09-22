import type { AppConfig } from "../../src/config/config.js";
import type {
  FetchedMessage,
  FetchedMessageSummary,
  FolderInfo,
  MailboxSnapshot
} from "../../src/domain/mail.js";
import type { ImapPort, SearchCriteria } from "../../src/adapters/imap-adapter.js";
import type {
  OutgoingMessage,
  SendResult,
  SmtpPort
} from "../../src/adapters/smtp-adapter.js";
import type { AuditEvent, AuditLogger } from "../../src/security/audit.js";

export class FakeImap implements ImapPort {
  readonly folders: FolderInfo[] = [
    {
      name: "INBOX",
      displayName: "INBOX",
      role: "inbox",
      selectable: true,
      specialUse: "\\Inbox"
    },
    {
      name: "Sent",
      displayName: "Sent",
      role: "sent",
      selectable: true,
      specialUse: "\\Sent"
    },
    {
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      selectable: true,
      specialUse: "\\Archive"
    },
    {
      name: "Trash",
      displayName: "Trash",
      role: "trash",
      selectable: true,
      specialUse: "\\Trash"
    }
  ];

  readonly messages = new Map<number, FetchedMessage>();
  readonly flagOperations: Array<{
    uid: number;
    operation: "add" | "remove" | "set";
    flags: string[];
  }> = [];
  readonly moves: Array<{ uid: number; destination: string }> = [];
  readonly appends: Array<{ folder: string; source: Buffer; flags: string[] }> = [];
  uidValidity = "100";
  searchResult: number[] = [];
  readonly searchCalls: SearchCriteria[] = [];
  capabilities = ["IMAP4rev1", "UIDPLUS", "MOVE"];

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async listFolders(): Promise<FolderInfo[]> {
    return this.folders;
  }

  async getCapabilities(): Promise<string[]> {
    return [...this.capabilities];
  }

  async openFolder(folder: string): Promise<MailboxSnapshot> {
    return {
      path: folder,
      exists: this.messages.size,
      uidValidity: this.uidValidity,
      uidNext: 999
    };
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    this.searchCalls.push({ ...criteria });
    if (criteria.messageId) {
      return [...this.messages.values()]
        .filter((message) => {
          const header = message.source
            .toString("utf8")
            .match(/^message-id:\s*(.+)$/im)?.[1]
            ?.trim();
          return header?.replace(/^<|>$/g, "") === criteria.messageId;
        })
        .map((message) => message.uid);
    }

    if (criteria.referencesMessageId) {
      return [...this.messages.values()]
        .filter((message) =>
          message.source
            .toString("utf8")
            .match(/^references:\s*(.+)$/im)?.[1]
            ?.includes(criteria.referencesMessageId as string)
        )
        .map((message) => message.uid);
    }

    if (criteria.inReplyToMessageId) {
      return [...this.messages.values()]
        .filter((message) =>
          message.source
            .toString("utf8")
            .match(/^in-reply-to:\s*(.+)$/im)?.[1]
            ?.replace(/[<>]/g, "")
            .trim() === criteria.inReplyToMessageId
        )
        .map((message) => message.uid);
    }

    return this.searchResult
      .filter((uid) => !criteria.beforeUid || uid < criteria.beforeUid)
      .sort((a, b) => b - a);
  }

  async fetchMessages(uids: number[]): Promise<FetchedMessage[]> {
    return uids
      .map((uid) => this.messages.get(uid))
      .filter((message): message is FetchedMessage => Boolean(message));
  }

  async existingUids(uids: number[]): Promise<Set<number>> {
    return new Set(uids.filter((uid) => this.messages.has(uid)));
  }

  async fetchSummaries(uids: number[]): Promise<FetchedMessageSummary[]> {
    return uids.flatMap((uid) => {
      const message = this.messages.get(uid);
      if (!message) {
        return [];
      }

      return [{
        uid: message.uid,
        flags: message.flags,
        internalDate: message.internalDate,
        hasAttachments: message.hasAttachments,
        attachmentCount: message.attachmentCount,
        snippetText: snippetFromSource(message.source),
        envelope: message.envelope
      }];
    });
  }

  async fetchMessage(uid: number): Promise<FetchedMessage | null> {
    return this.messages.get(uid) ?? null;
  }

  async updateFlags(
    uid: number,
    operation: "add" | "remove" | "set",
    flags: string[]
  ): Promise<void> {
    this.flagOperations.push({ uid, operation, flags });
  }

  async moveMessage(uid: number, destination: string): Promise<void> {
    this.moves.push({ uid, destination });
  }

  async append(folder: string, source: Buffer, flags: string[] = []): Promise<void> {
    this.appends.push({ folder, source, flags });
  }
}

export class FakeSmtp implements SmtpPort {
  readonly sent: OutgoingMessage[] = [];
  verified = false;
  acceptedOverride: string[] | null = null;
  rejectedOverride: string[] = [];

  async verify(): Promise<void> {
    this.verified = true;
  }

  async send(message: OutgoingMessage, raw?: Buffer): Promise<SendResult> {
    this.sent.push(message);
    return {
      messageId: "fake-message-id",
      accepted:
        this.acceptedOverride ??
        [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
      rejected: [...this.rejectedOverride],
      response: "250 OK",
      raw: raw ?? Buffer.from("raw")
    };
  }

  close(): void {}
}

export class FakeAudit implements AuditLogger {
  readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export function testConfig(overrides: Partial<AppConfig["permissions"]> = {}): AppConfig {
  return {
    account: {
      email: "me@qq.com"
    },
    permissions: {
      read: true,
      update: false,
      send: false,
      ...overrides
    },
    imap: {
      host: "imap.qq.com",
      port: 993,
      secure: true
    },
    smtp: {
      host: "smtp.qq.com",
      port: 465,
      secure: true
    },
    security: {
      credentialTarget: "qq-email-mcp",
      attachmentDir: "E:/tmp/qq-email-mcp-test",
      maxAttachmentBytes: 1024,
      maxTotalAttachmentBytes: 2048,
      allowRemoteImages: false
    },
    send: {
      saveSent: "never"
    },
    configPath: null
  };
}

export function rawMessage(options: {
  subject?: string;
  from?: string;
  to?: string;
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  attachment?: {
    filename: string;
    contentType: string;
    content: string;
  };
} = {}): Buffer {
  const headers = [
      `From: ${options.from ?? "sender@example.com"}`,
      `To: ${options.to ?? "me@qq.com"}`,
      `Subject: ${options.subject ?? "Hello"}`,
      `Message-ID: <${options.messageId ?? "message-1@example.com"}>`,
      ...(options.replyTo ? [`Reply-To: ${options.replyTo}`] : []),
      ...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
      ...(options.references
        ? [`References: ${options.references.map((value) => `<${value}>`).join(" ")}`]
        : []),
      "Date: Sun, 21 Sep 2026 10:00:00 +0800",
      "MIME-Version: 1.0"
    ];

  if (!options.attachment) {
    return Buffer.from(
      [
        ...headers,
        'Content-Type: text/plain; charset="utf-8"',
        "",
        options.text ?? "Body"
      ].join("\r\n"),
      "utf8"
    );
  }

  return Buffer.from(
    [
      ...headers,
      'Content-Type: multipart/mixed; boundary="boundary"',
      "",
      "--boundary",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      options.text ?? "Body",
      "--boundary",
      `Content-Type: ${options.attachment.contentType}; name="${options.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
      "",
      options.attachment.content,
      "--boundary--",
      ""
    ].join("\r\n"),
    "utf8"
  );
}

export function fetchedMessage(uid: number, source = rawMessage()): FetchedMessage {
  const sourceText = source.toString("utf8");
  const attachmentCount = (sourceText.match(/content-disposition:\s*attachment/gi) ?? []).length;
  return {
    uid,
    source,
    flags: new Set<string>(),
    internalDate: new Date("2026-09-21T02:00:00.000Z"),
    hasAttachments: attachmentCount > 0,
    attachmentCount,
    envelope: {
      subject: "Hello",
      date: new Date("2026-09-21T02:00:00.000Z"),
      messageId: "message-1@example.com",
      from: [{ name: "Sender", address: "sender@example.com" }],
      to: [{ name: null, address: "me@qq.com" }]
    }
  };
}

function snippetFromSource(source: Buffer): string | null {
  const decoded = source.toString("utf8");
  const headerEnd = decoded.search(/\r?\n\r?\n/);
  const body = headerEnd >= 0 ? decoded.slice(headerEnd).replace(/^\r?\n\r?\n/, "") : decoded;
  const text = body
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}
