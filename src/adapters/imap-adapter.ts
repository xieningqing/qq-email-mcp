import { ImapFlow } from "imapflow";
import type {
  FetchMessageObject,
  ListResponse,
  MailboxObject,
  MessageStructureObject,
  SearchObject
} from "imapflow";
import { TextDecoder } from "node:util";
import { AppError, networkFailureKind } from "../errors.js";
import type {
  FetchedMessage,
  FetchedMessageSummary,
  FolderInfo,
  MailboxSnapshot,
  MessageSummary
} from "../domain/mail.js";

export interface SearchCriteria {
  query?: string | undefined;
  from?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  unreadOnly?: boolean | undefined;
  beforeUid?: number | undefined;
  messageId?: string | undefined;
  referencesMessageId?: string | undefined;
  inReplyToMessageId?: string | undefined;
}

export interface ImapAdapterOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface ImapPort {
  connect(): Promise<void>;
  close(): Promise<void>;
  getCapabilities(): Promise<string[]>;
  listFolders(): Promise<FolderInfo[]>;
  openFolder(folder: string): Promise<MailboxSnapshot>;
  search(criteria: SearchCriteria): Promise<number[]>;
  fetchSummaries(
    uids: number[],
    options?: { includeSnippet?: boolean | undefined }
  ): Promise<FetchedMessageSummary[]>;
  existingUids(uids: number[]): Promise<Set<number>>;
  fetchMessages(uids: number[]): Promise<FetchedMessage[]>;
  fetchMessage(uid: number): Promise<FetchedMessage | null>;
  updateFlags(
    uid: number,
    operation: "add" | "remove" | "set",
    flags: string[]
  ): Promise<void>;
  moveMessage(uid: number, destination: string): Promise<void>;
  append(folder: string, source: Buffer, flags?: string[]): Promise<void>;
}

function toFolderInfo(folder: ListResponse | MailboxObject): FolderInfo {
  return {
    name: folder.path,
    displayName: folder.path,
    role: folder.specialUse
      ? folder.specialUse.replace(/^\\/, "").toLowerCase()
      : null,
    selectable: !("flags" in folder && folder.flags.has("\\Noselect")),
    specialUse: folder.specialUse ?? null
  };
}

function errorToAppError(error: unknown, message: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const candidate = error as {
    code?: string;
    authenticationFailed?: boolean;
    responseCode?: string;
    textCode?: string;
  };
  if (
    candidate.authenticationFailed ||
    candidate.code === "AUTHENTICATIONFAILED" ||
    candidate.code === "AUTHORIZATIONFAILED"
  ) {
    return new AppError("AUTH_FAILED", "QQ Mail authentication failed", {
      cause: error
    });
  }

  if (
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "CONNECT_TIMEOUT" ||
    candidate.code === "GreetingTimeout"
  ) {
    return new AppError("TIMEOUT", "QQ Mail connection timed out", {
      retryable: true,
      cause: error
    });
  }

  if (
    candidate.code === "NONEXISTENT" ||
    candidate.responseCode === "NONEXISTENT" ||
    candidate.textCode === "NONEXISTENT"
  ) {
    return new AppError("FOLDER_NOT_FOUND", "QQ Mail folder was not found", {
      cause: error
    });
  }

  if (candidate.code && typeof candidate.code === "string") {
    return new AppError("NETWORK_ERROR", "QQ Mail network operation failed", {
      retryable: true,
      details: {
        code: candidate.code,
        kind: networkFailureKind(candidate.code)
      },
      cause: error
    });
  }

  return new AppError("IMAP_OPERATION_FAILED", message, { cause: error });
}

function hasAttachments(structure: MessageStructureObject | undefined): boolean {
  return countAttachments(structure) > 0;
}

function countAttachments(structure: MessageStructureObject | undefined): number {
  if (!structure) {
    return 0;
  }

  if (
    structure.disposition?.toLowerCase() === "attachment" ||
    Boolean(structure.dispositionParameters?.filename || structure.dispositionParameters?.name)
  ) {
    return 1;
  }

  return (structure.childNodes ?? []).reduce(
    (total, child) => total + countAttachments(child),
    0
  );
}

function decodeQuotedPrintable(value: Buffer): Buffer {
  const input = value.toString("latin1");
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "=") {
      bytes.push(input.charCodeAt(index));
      continue;
    }

    const next = input[index + 1];
    if (next === "\r" && input[index + 2] === "\n") {
      index += 2;
      continue;
    }
    if (next === "\n") {
      index += 1;
      continue;
    }

    const hex = input.slice(index + 1, index + 3);
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }

    bytes.push(0x3d);
  }

  return Buffer.from(bytes);
}

function decodeBodyPart(
  value: Buffer,
  structure: MessageStructureObject
): string {
  const encoding = structure.encoding?.toLowerCase();
  const base64 = value.toString("ascii").replace(/\s+/g, "");
  const paddedBase64 = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  const decoded =
    encoding === "quoted-printable"
      ? decodeQuotedPrintable(value)
      : encoding === "base64"
        ? Buffer.from(paddedBase64, "base64")
        : value;
  const charset = structure.parameters?.charset ?? "utf-8";

  try {
    return new TextDecoder(charset).decode(decoded);
  } catch {
    return decoded.toString("utf8");
  }
}

function selectSnippetPart(
  structure: MessageStructureObject | undefined
): { key: string; structure: MessageStructureObject } | null {
  if (!structure || structure.disposition?.toLowerCase() === "attachment") {
    return null;
  }

  const type = structure.type.toLowerCase();
  if (type === "text/plain") {
    return { key: structure.part ?? "TEXT", structure };
  }

  const children = structure.childNodes ?? [];
  const plain = children
    .map((child) => selectSnippetPart(child))
    .find((part) => part?.structure.type.toLowerCase() === "text/plain");
  if (plain) {
    return plain;
  }

  if (type === "text/html") {
    return { key: structure.part ?? "TEXT", structure };
  }

  return (
    children
      .map((child) => selectSnippetPart(child))
      .find((part) => part?.structure.type.toLowerCase() === "text/html") ?? null
  );
}

function normalizeSnippet(
  value: Buffer | undefined,
  structure: MessageStructureObject | undefined
): string | null {
  if (!value || value.length === 0) {
    return null;
  }

  const text = decodeBodyPart(value, structure ?? { type: "text/plain" })
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160|#xA0);/gi, " ")
    .replace(/&(?:amp|#38|#x26);/gi, "&")
    .replace(/&(?:lt|#60|#x3C);/gi, "<")
    .replace(/&(?:gt|#62|#x3E);/gi, ">")
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

export class ImapAdapter implements ImapPort {
  private client: ImapFlow;
  private connected = false;
  private connectAttempted = false;
  private connectPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private openedFolder: MailboxSnapshot | null = null;

  constructor(
    private readonly options: ImapAdapterOptions,
    private readonly clientFactory: (
      options: ImapAdapterOptions
    ) => ImapFlow = (adapterOptions) => new ImapFlow({
      host: adapterOptions.host,
      port: adapterOptions.port,
      secure: adapterOptions.secure,
      auth: {
        user: adapterOptions.user,
        pass: adapterOptions.password
      },
      clientInfo: {
        name: "qq-email-mcp",
        version: "0.1.0"
      },
      disableAutoIdle: true,
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 120_000
    })
  ) {
    this.client = this.createClient();
  }

  private createClient(): ImapFlow {
    const client = this.clientFactory(this.options);

    client.on("close", () => {
      this.connected = false;
      this.connectPromise = null;
      this.openedFolder = null;
    });
    client.on("error", () => {
      this.connected = false;
      this.connectPromise = null;
      this.openedFolder = null;
    });

    return client;
  }

  /*
   * The client is rebuilt after a disconnect because imapflow does not
   * reconnect automatically.
   */
  private rebuildClient(): void {
    this.client = this.createClient();
  }

  async connect(): Promise<void> {
    if (this.connected && this.client.usable) {
      return;
    }

    this.connected = false;
    this.connectPromise ??= this.connectInternal();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectInternal(): Promise<void> {
    try {
      if (this.connectAttempted && !this.client.usable) {
        this.rebuildClient();
      }
      this.connectAttempted = true;
      await this.client.connect();
      this.connected = true;
    } catch (error) {
      throw errorToAppError(error, "Unable to connect to QQ Mail IMAP");
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.client.usable) {
      await this.client.logout();
    } else {
      this.client.close();
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.run(async () => {
      const folders = await this.client.list();
      return folders.map(toFolderInfo);
    }, "Unable to list folders", { retryOnDisconnect: true });
  }

  async getCapabilities(): Promise<string[]> {
    await this.connect();
    return [...this.client.capabilities.keys()].sort();
  }

  async openFolder(folder: string): Promise<MailboxSnapshot> {
    return this.run(async () => {
      if (this.openedFolder?.path === folder) {
        return this.openedFolder;
      }
      const mailbox = await this.client.mailboxOpen(folder);
      const snapshot = {
        path: mailbox.path,
        exists: mailbox.exists,
        uidValidity: mailbox.uidValidity.toString(),
        uidNext: mailbox.uidNext
      };
      this.openedFolder = snapshot;
      return snapshot;
    }, `Unable to open folder ${folder}`, { retryOnDisconnect: true });
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    return this.run(async () => {
      const query: SearchObject = {};
      if (criteria.unreadOnly) {
        query.seen = false;
      }
      if (criteria.query) {
        query.text = criteria.query;
      }
      if (criteria.from) {
        query.from = criteria.from;
      }
      if (criteria.since) {
        query.since = criteria.since;
      }
      if (criteria.before) {
        query.before = criteria.before;
      }
      if (criteria.beforeUid && criteria.beforeUid > 1) {
        query.uid = `1:${criteria.beforeUid - 1}`;
      } else if (criteria.beforeUid === 1) {
        return [];
      }
      if (criteria.messageId) {
        query.header = {
          "Message-ID": criteria.messageId
        };
      }
      if (criteria.referencesMessageId) {
        query.header = {
          ...(query.header ?? {}),
          References: criteria.referencesMessageId
        };
      }
      if (criteria.inReplyToMessageId) {
        query.header = {
          ...(query.header ?? {}),
          "In-Reply-To": criteria.inReplyToMessageId
        };
      }

      if (Object.keys(query).length === 0 || (Object.keys(query).length === 1 && query.uid)) {
        query.all = true;
      }

      const result = await this.client.search(query, { uid: true });
      if (result === false) {
        throw new AppError(
          "IMAP_OPERATION_FAILED",
          "IMAP SEARCH failed; the server rejected the search criteria"
        );
      }

      return [...result]
        .filter((uid) => !criteria.beforeUid || uid < criteria.beforeUid)
        .sort((a, b) => b - a);
    }, "Unable to search messages", { retryOnDisconnect: true });
  }

  async fetchSummaries(
    uids: number[],
    options: { includeSnippet?: boolean | undefined } = {}
  ): Promise<FetchedMessageSummary[]> {
    if (uids.length === 0) {
      return [];
    }

    const includeSnippet = options.includeSnippet ?? true;

    return this.run(async () => {
      const metadata = await this.client.fetchAll(
        uids,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true
        },
        { uid: true }
      );

      const parts = includeSnippet
        ? metadata
        .map((row) => ({
          uid: row.uid,
          part: selectSnippetPart(row.bodyStructure)
        }))
        .filter(
          (
            item
          ): item is {
            uid: number;
            part: { key: string; structure: MessageStructureObject };
          } => Boolean(item.part)
            )
        : [];
      const partKeys = [...new Set(parts.map((item) => item.part.key))];
      const snippets =
        partKeys.length === 0
          ? []
          : await this.client.fetchAll(
              parts.map((item) => item.uid),
              {
                uid: true,
                bodyParts: partKeys.map((key) => ({
                  key,
                  start: 0,
                  maxLength: 4096
                }))
              },
              { uid: true }
            );
      const snippetRows = new Map(snippets.map((row) => [row.uid, row]));
      const metadataByUid = new Map(metadata.map((row) => [row.uid, row]));

      return uids.flatMap((uid) => {
        const row = metadataByUid.get(uid);
        if (!row) {
          return [];
        }
        const part = parts.find((item) => item.uid === row.uid)?.part;
        const snippetRow = snippetRows.get(row.uid);
        return [
          {
            uid: row.uid,
            flags: row.flags ?? new Set<string>(),
            internalDate:
              row.internalDate instanceof Date
                ? row.internalDate
                : row.internalDate
                  ? new Date(row.internalDate)
                  : null,
            hasAttachments: hasAttachments(row.bodyStructure),
            attachmentCount: countAttachments(row.bodyStructure),
            snippetText: normalizeSnippet(
              part && snippetRow?.bodyParts?.get(part.key),
              part?.structure
            ),
            envelope: row.envelope ?? null
          }
        ];
      });
    }, "Unable to fetch message summaries", { retryOnDisconnect: true });
  }

  async fetchMessages(uids: number[]): Promise<FetchedMessage[]> {
    if (uids.length === 0) {
      return [];
    }

    return this.run(async () => {
      const rows = await this.client.fetchAll(
        uids,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          source: true,
          size: true
        },
        { uid: true }
      );

      return rows.map((row) => ({
        uid: row.uid,
        source: row.source ?? Buffer.alloc(0),
        flags: row.flags ?? new Set<string>(),
        internalDate:
          row.internalDate instanceof Date
            ? row.internalDate
            : row.internalDate
              ? new Date(row.internalDate)
              : null,
        hasAttachments: hasAttachments(row.bodyStructure),
        attachmentCount: countAttachments(row.bodyStructure),
        envelope: row.envelope ?? null
      }));
    }, "Unable to fetch messages", { retryOnDisconnect: true });
  }

  async existingUids(uids: number[]): Promise<Set<number>> {
    const unique = [...new Set(uids)];
    if (unique.length === 0) {
      return new Set<number>();
    }

    return this.run(async () => {
      const rows = await this.client.fetchAll(
        unique,
        { uid: true },
        { uid: true }
      );
      return new Set(rows.map((row) => row.uid));
    }, "Unable to check message existence", { retryOnDisconnect: true });
  }

  async fetchMessage(uid: number): Promise<FetchedMessage | null> {
    return this.run(async () => {
      const row = await this.client.fetchOne(
        String(uid),
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          source: true
        },
        { uid: true }
      );

      if (!row) {
        return null;
      }

      return {
        uid: row.uid,
        source: row.source ?? Buffer.alloc(0),
        flags: row.flags ?? new Set<string>(),
        internalDate:
          row.internalDate instanceof Date
            ? row.internalDate
            : row.internalDate
              ? new Date(row.internalDate)
              : null,
        hasAttachments: hasAttachments(row.bodyStructure),
        attachmentCount: countAttachments(row.bodyStructure),
        envelope: row.envelope ?? null
      };
    }, "Unable to fetch message", { retryOnDisconnect: true });
  }

  async updateFlags(
    uid: number,
    operation: "add" | "remove" | "set",
    flags: string[]
  ): Promise<void> {
    await this.run(async () => {
      let succeeded: boolean;
      if (operation === "add") {
        this.openedFolder = null;
        succeeded = await this.client.messageFlagsAdd([uid], flags, { uid: true });
      } else if (operation === "remove") {
        this.openedFolder = null;
        succeeded = await this.client.messageFlagsRemove([uid], flags, { uid: true });
      } else {
        this.openedFolder = null;
        succeeded = await this.client.messageFlagsSet([uid], flags, { uid: true });
      }
      if (!succeeded) {
        throw new AppError("IMAP_OPERATION_FAILED", "Unable to update message flags");
      }
    }, "Unable to update message flags");
  }

  async moveMessage(uid: number, destination: string): Promise<void> {
    await this.run(async () => {
      const result = await this.client.messageMove([uid], destination, { uid: true });
      this.openedFolder = null;
      if (!result) {
        throw new AppError("IMAP_OPERATION_FAILED", "Unable to move message");
      }
    }, "Unable to move message");
  }

  async append(folder: string, source: Buffer, flags: string[] = []): Promise<void> {
    await this.run(async () => {
      const result = await this.client.append(folder, source, flags);
      this.openedFolder = null;
      if (!result) {
        throw new AppError("IMAP_OPERATION_FAILED", "Unable to append message");
      }
    }, "Unable to append message");
  }

  private async run<T>(
    operation: () => Promise<T>,
    message: string,
    options: { retryOnDisconnect?: boolean } = {}
  ): Promise<T> {
    await this.connect();
    const next = this.queue.then(async () => {
      try {
        if (!this.client.usable) {
          this.connected = false;
          await this.connect();
        }
        return await operation();
      } catch (error) {
        const appError = errorToAppError(error, message);
        if (options.retryOnDisconnect && appError.retryable) {
          this.connected = false;
          try {
            await this.connect();
            return await operation();
          } catch (retryError) {
            throw errorToAppError(retryError, message);
          }
        }
        throw appError;
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
