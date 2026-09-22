import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config.js";
import type {
  AgentContext,
  AttachmentSummary,
  FolderInfo,
  MessageSummary,
  ThreadContext,
  ThreadMessage
} from "../domain/mail.js";
import {
  decodeBodyCursor,
  decodeCursor,
  decodeMessageRef,
  encodeBodyCursor,
  encodeCursor,
  encodeMessageRef
} from "../domain/message-ref.js";
import { AppError } from "../errors.js";
import type { SearchCriteria } from "../adapters/imap-adapter.js";
import type { ImapPort } from "../adapters/imap-adapter.js";
import type { OutgoingMessage } from "../adapters/smtp-adapter.js";
import { outgoingFingerprint } from "../adapters/smtp-adapter.js";
import type { SmtpPort } from "../adapters/smtp-adapter.js";
import { extractAttachmentText } from "../mime/attachment-text.js";
import { normalizeMessage, type NormalizedMessage } from "../mime/normalize.js";
import { AttachmentSandbox, sanitizeFilename } from "../security/attachment-sandbox.js";
import type { AuditLogger } from "../security/audit.js";
import { ConfirmationStore } from "../security/confirmation.js";

export interface MailServiceOptions {
  config: AppConfig;
  imap: ImapPort;
  smtp: SmtpPort;
  audit: AuditLogger;
  confirmations?: ConfirmationStore<OutgoingMessage>;
}

export interface ListInput {
  folder?: string | undefined;
  limit?: number | undefined;
  unreadOnly?: boolean | undefined;
  cursor?: string | null | undefined;
  since?: string | undefined;
  before?: string | undefined;
  recentDays?: number | undefined;
  includeSnippet?: boolean | undefined;
}

export interface SearchInput extends ListInput {
  query?: string | undefined;
  from?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
}

export interface DigestInput {
  folder?: string | undefined;
  recentDays: number;
  unreadOnly?: boolean | undefined;
  limit?: number | undefined;
  includeSnippet?: boolean | undefined;
}

export interface GetInput {
  messageRef: string;
  mode?: "metadata" | "text" | "thread" | "agent" | undefined;
  maxChars?: number | undefined;
  includeLinks?: boolean | undefined;
  includeAttachments?: boolean | undefined;
  cursor?: string | null | undefined;
}

export interface AttachmentInput {
  messageRef: string;
  attachmentId: string;
  action?: "metadata" | "download" | "extract_text" | undefined;
  maxChars?: number | undefined;
}

export interface SendInput {
  mode?: "new" | "reply" | "reply_all" | "forward" | undefined;
  messageRef?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  includeOriginal?: boolean | undefined;
  attachments?: Array<{
    filename: string;
    contentType?: string | undefined;
    contentBase64: string;
  }> | undefined;
  previewOnly?: boolean | undefined;
  includeOriginalAttachments?: boolean | undefined;
  confirmationToken?: string | undefined;
}

export type UpdateAction =
  | "mark_read"
  | "mark_unread"
  | "flag"
  | "unflag"
  | "move"
  | "archive"
  | "trash";

export interface UpdateInput {
  messageRefs: string[];
  action: UpdateAction;
  targetFolder?: string | undefined;
}

export interface DraftInput {
  mode?: "new" | "reply" | "reply_all" | "forward" | undefined;
  messageRef?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  includeOriginal?: boolean | undefined;
  includeOriginalAttachments?: boolean | undefined;
  attachments?: Array<{
    filename: string;
    contentType?: string | undefined;
    contentBase64: string;
  }> | undefined;
  messageRefToUpdate?: string | undefined;
}

interface ResolvedMessage {
  folder: string;
  uidValidity: string;
  uid: number;
}

function queryHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export class MailService {
  private readonly confirmations: ConfirmationStore<OutgoingMessage>;
  private readonly sandbox: AttachmentSandbox;
  private folderCache: FolderInfo[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MailServiceOptions) {
    this.confirmations = options.confirmations ?? new ConfirmationStore();
    this.sandbox = new AttachmentSandbox(options.config.security.attachmentDir);
  }

  async status() {
    return this.audited("mail_status", "status", () => this.statusInternal());
  }

  async folders(): Promise<{ folders: FolderInfo[] }> {
    return this.audited("mail_folders", "list_folders", () => this.foldersInternal());
  }

  async list(input: ListInput = {}): Promise<{
    messages: MessageSummary[];
    nextCursor: string | null;
  }> {
    return this.audited(
      "mail_list",
      "list_messages",
      () => this.listInternal(input),
      { folder: input.folder ?? "INBOX" }
    );
  }

  async search(input: SearchInput): Promise<{
    messages: MessageSummary[];
    nextCursor: string | null;
    search: { executedServerSide: true; query: string | null };
  }> {
    return this.audited(
      "mail_search",
      "search_messages",
      () => this.searchInternal(input),
      { folder: input.folder ?? "INBOX" }
    );
  }

  async digest(input: DigestInput): Promise<{
    folder: string;
    since: string;
    total: number;
    unread: number;
    withAttachments: number;
    messages: MessageSummary[];
  }> {
    return this.audited(
      "mail_digest",
      "digest",
      () => this.digestInternal(input),
      { folder: input.folder ?? "INBOX" }
    );
  }

  async get(input: GetInput): Promise<unknown> {
    const ref = decodeMessageRef(input.messageRef);
    return this.audited(
      "mail_get",
      `read_${input.mode ?? "agent"}`,
      () => this.getInternal(input),
      { folder: ref.folder, uid: ref.uid }
    );
  }

  async attachment(input: AttachmentInput) {
    const ref = decodeMessageRef(input.messageRef);
    return this.audited(
      "mail_attachment",
      input.action ?? "metadata",
      () => this.attachmentInternal(input),
      { folder: ref.folder, uid: ref.uid }
    );
  }

  async send(input: SendInput): Promise<Record<string, unknown>> {
    return this.audited(
      "mail_send",
      input.confirmationToken ? "send" : "preview",
      () => this.sendInternal(input),
      {},
      (result) => {
        if (result.status === "failed") {
          return { result: "failure", errorCode: "SMTP_SEND_FAILED" };
        }
        return { result: "success" };
      }
    );
  }

  async draft(input: DraftInput): Promise<Record<string, unknown>> {
    return this.audited(
      "mail_draft",
      input.messageRefToUpdate ? "update_draft" : "create_draft",
      () => this.draftInternal(input),
      {},
      (result) => ({
        result: result.status === "failed" ? "failure" : "success",
        ...(result.status === "failed" ? { errorCode: "IMAP_OPERATION_FAILED" } : {})
      })
    );
  }

  async update(input: UpdateInput) {
    return this.audited(
      "mail_update",
      input.action,
      () => this.updateInternal(input),
      {},
      (result) => {
        if (result.updated === 0 && result.failed.length > 0) {
          return {
            result: "failure",
            errorCode: "PARTIAL_UPDATE_FAILED"
          };
        }
        return { result: "success" };
      }
    );
  }

  cancelSend(confirmationToken: string): { cancelled: true } {
    this.confirmations.revoke(confirmationToken);
    return { cancelled: true };
  }

  private async statusInternal() {
    const warnings: string[] = [];
    let imapStatus: "ok" | "error" = "ok";
    let smtpStatus: "ok" | "error" = "ok";
    let foldersStatus: "ok" | "error" = "ok";
    let folders: FolderInfo[] = [];
    let capabilities: string[] = [];

    try {
      await this.options.imap.connect();
      folders = await this.options.imap.listFolders();
      capabilities = await this.options.imap.getCapabilities();
    } catch (error) {
      imapStatus = "error";
      warnings.push(statusWarning("IMAP", error));
    }

    try {
      await this.options.smtp.verify();
    } catch (error) {
      smtpStatus = "error";
      warnings.push(statusWarning("SMTP", error));
    }

    if (imapStatus === "error") {
      foldersStatus = "error";
    }

    return {
      account: this.options.config.account.email,
      connected: imapStatus === "ok",
      ready: imapStatus === "ok" && smtpStatus === "ok",
      imap: imapStatus,
      smtp: smtpStatus,
      folders: foldersStatus,
      folderRoles: folders
        .filter((folder) => folder.role)
        .map((folder) => ({
          name: folder.name,
          role: folder.role
        })),
      capabilities,
      permissions: {
        read: this.options.config.permissions.read,
        draft: this.options.config.permissions.draft || this.options.config.permissions.update,
        update: this.options.config.permissions.update,
        send: this.options.config.permissions.send
      },
      warnings
    };
  }

  private async foldersInternal(): Promise<{ folders: FolderInfo[] }> {
    this.assertReadAllowed();
    this.folderCache = await this.options.imap.listFolders();
    return { folders: this.folderCache };
  }

  private async listInternal(input: ListInput): Promise<{
    messages: MessageSummary[];
    nextCursor: string | null;
  }> {
    this.assertReadAllowed();
    const { since, before } = resolveListDateRange(input);
    validateSearchDates(since, before);
    const folder = input.folder ?? "INBOX";
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const snapshot = await this.options.imap.openFolder(folder);
    const cursor = input.cursor
      ? decodeCursor(input.cursor)
      : null;
    const criteria: SearchCriteria = {
      unreadOnly: input.unreadOnly,
      since,
      before,
      beforeUid: cursor?.lastUid
    };
    const hash = queryHash({
      folder,
      criteria: {
        unreadOnly: input.unreadOnly,
        since,
        before,
        recentDays: input.recentDays
      }
    });

    if (
      cursor &&
      (cursor.folder !== folder ||
        cursor.uidValidity !== snapshot.uidValidity ||
        cursor.queryHash !== hash)
    ) {
      throw new AppError(
        "STALE_MESSAGE_REF",
        "Cursor is no longer valid for this folder or query"
      );
    }

    const matchingUids = await this.options.imap.search(criteria);
    const selected = matchingUids.slice(0, limit);
    const messages = await this.summariesFor(folder, snapshot.uidValidity, selected, {
      includeSnippet: input.includeSnippet
    });
    const last = selected.at(-1);

    return {
      messages,
      nextCursor:
        last && matchingUids.length > limit
          ? encodeCursor({
              folder,
              uidValidity: snapshot.uidValidity,
              lastUid: last,
              queryHash: hash
            })
          : null
    };
  }

  private async searchInternal(input: SearchInput): Promise<{
    messages: MessageSummary[];
    nextCursor: string | null;
    search: { executedServerSide: true; query: string | null };
  }> {
    this.assertReadAllowed();
    const { since, before } = resolveListDateRange(input);
    validateSearchDates(since, before);
    const folder = input.folder ?? "INBOX";
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const snapshot = await this.options.imap.openFolder(folder);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const criteria: SearchCriteria = {
      query: input.query,
      from: input.from,
      since,
      before,
      unreadOnly: input.unreadOnly,
      beforeUid: cursor?.lastUid
    };
    const hash = queryHash({
      folder,
      criteria: {
        query: input.query,
        from: input.from,
        since,
        before,
        recentDays: input.recentDays,
        unreadOnly: input.unreadOnly
      }
    });

    if (
      cursor &&
      (cursor.folder !== folder ||
        cursor.uidValidity !== snapshot.uidValidity ||
        cursor.queryHash !== hash)
    ) {
      throw new AppError(
        "STALE_MESSAGE_REF",
        "Cursor is no longer valid for this folder or query"
      );
    }

    const matchingUids = await this.options.imap.search(criteria);
    const selected = matchingUids.slice(0, limit);
    const messages = await this.summariesFor(folder, snapshot.uidValidity, selected, {
      includeSnippet: input.includeSnippet
    });
    const last = selected.at(-1);

    return {
      messages,
      nextCursor:
        last && matchingUids.length > limit
          ? encodeCursor({
              folder,
              uidValidity: snapshot.uidValidity,
              lastUid: last,
              queryHash: hash
            })
          : null,
      search: {
        executedServerSide: true,
        query: input.query ?? null
      }
    };
  }

  private async digestInternal(input: DigestInput): Promise<{
    folder: string;
    since: string;
    total: number;
    unread: number;
    withAttachments: number;
    messages: MessageSummary[];
  }> {
    this.assertReadAllowed();

    if (!Number.isInteger(input.recentDays) || input.recentDays <= 0) {
      throw new AppError("INVALID_INPUT", "recent_days must be a positive integer");
    }

    const folder = input.folder ?? "INBOX";
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const since = new Date(Date.now() - input.recentDays * 24 * 60 * 60 * 1000).toISOString();

    const snapshot = await this.options.imap.openFolder(folder);
    const uids = await this.options.imap.search({
      since,
      unreadOnly: input.unreadOnly
    });

    const summaries = await this.summariesFor(
      folder,
      snapshot.uidValidity,
      uids.slice(0, limit),
      { includeSnippet: input.includeSnippet }
    );
    const unread = summaries.filter((message) => message.unread).length;
    const withAttachments = summaries.filter((message) => message.hasAttachments).length;

    return {
      folder,
      since,
      total: uids.length,
      unread,
      withAttachments,
      messages: summaries
    };
  }

  private async getInternal(input: GetInput): Promise<unknown> {
    this.assertReadAllowed();
    const bundle = await this.loadMessage(input.messageRef);
    const mode = input.mode ?? "agent";

    if (mode === "metadata") {
      this.assertNoBodyCursor(mode, input.cursor);
      return {
        messageRef: input.messageRef,
        threadRef: threadRootRef(bundle.normalized),
        subject: bundle.normalized.subject,
        from: bundle.normalized.from,
        to: bundle.normalized.to,
        cc: bundle.normalized.cc,
        replyTo: bundle.normalized.replyTo,
        date: bundle.normalized.date,
        messageId: bundle.normalized.messageId,
        inReplyTo: bundle.normalized.inReplyTo,
        references: bundle.normalized.references,
        unread: !bundle.flags.has("\\Seen"),
        flagged: bundle.flags.has("\\Flagged"),
        hasAttachments: bundle.normalized.attachments.length > 0,
        attachmentCount: bundle.normalized.attachments.length,
        attachments: bundle.normalized.attachments.map(this.attachmentSummary),
        isUntrusted: true
      };
    }

    if (mode === "thread") {
      this.assertNoBodyCursor(mode, input.cursor);
      return this.toThreadContext(input, bundle);
    }

    if (mode === "text") {
      const maxChars = this.resolveBodyMaxChars(input, "text");
      const offset = this.resolveBodyOffset(input, "text");
      const text = bundle.normalized.fullText.slice(offset, offset + maxChars);
      const nextOffset = offset + text.length;
      return {
        messageRef: input.messageRef,
        threadRef: threadRootRef(bundle.normalized),
        subject: bundle.normalized.subject,
        date: bundle.normalized.date,
        text,
        truncated: nextOffset < bundle.normalized.fullText.length,
        nextCursor:
          nextOffset < bundle.normalized.fullText.length
            ? encodeBodyCursor({
                messageRef: input.messageRef,
                mode: "text",
                offset: nextOffset,
                maxChars
              })
            : null,
        isUntrusted: true
      };
    }

    return this.toAgentContext(input, bundle);
  }

  private async attachmentInternal(input: AttachmentInput) {
    this.assertReadAllowed();
    const { normalized } = await this.loadMessage(input.messageRef);
    const attachment = normalized.attachments.find(
      (candidate) => candidate.attachmentId === input.attachmentId
    );
    if (!attachment) {
      throw new AppError("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    }

    const action = input.action ?? "metadata";
    if (action === "metadata") {
      return this.attachmentSummary(attachment);
    }

    if (attachment.size > this.options.config.security.maxAttachmentBytes) {
      throw new AppError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured size limit", {
        details: {
          size: attachment.size,
          limit: this.options.config.security.maxAttachmentBytes
        }
      });
    }

    if (action === "download") {
      const target = await this.sandbox.save(attachment.content, attachment.filename);
      return {
        ...this.attachmentSummary(attachment),
        downloadPath: target
      };
    }

    const maxChars = Math.min(Math.max(input.maxChars ?? 50_000, 1), 500_000);
    let extracted;
    try {
      extracted = await extractAttachmentText(
        attachment.content,
        attachment.filename,
        attachment.contentType
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(error.code, error.message, {
          retryable: error.retryable,
          details: {
            ...error.details,
            attachment: this.attachmentSummary(attachment)
          },
          cause: error
        });
      }
      throw error;
    }
    const extractedText = extracted.text.slice(0, maxChars);
    return {
      ...this.attachmentSummary(attachment),
      extractedText,
      characterCount: extracted.text.length,
      truncated: extracted.text.length > maxChars,
      extractor: extracted.extractor
    };
  }

  private async sendInternal(input: SendInput): Promise<Record<string, unknown>> {
    this.assertSendAllowed();
    if (input.confirmationToken && input.previewOnly) {
      throw new AppError(
        "INVALID_INPUT",
        "confirmationToken and previewOnly cannot be used together"
      );
    }
    if (input.confirmationToken) {
      // The token is bound to the exact normalized outgoing content.
      const payload = this.confirmations.consume(
        input.confirmationToken,
        outgoingFingerprint
      );
      const result = await this.options.smtp.send(payload);
      let sentSaveError: string | null = null;
      try {
        await this.maybeSaveSent(result.raw, payload);
      } catch (error) {
        sentSaveError =
          error instanceof Error ? error.message : "Unable to save the message to Sent";
      }
      const status =
        result.accepted.length === 0 || result.rejected.length > 0
          ? result.accepted.length > 0
            ? "partial_failure"
            : "failed"
          : "sent";
      return {
        status,
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        response: result.response,
        sentSaveError
      };
    }

    const payload = await this.resolveSendInput(input);
    const fingerprint = outgoingFingerprint(payload);
    const confirmationToken = this.confirmations.create(fingerprint, payload);
    const attachmentTotalBytes = (payload.attachments ?? []).reduce(
      (total, attachment) => total + attachment.content.length,
      0
    );
    return {
      status: input.previewOnly ? "preview" : "confirmation_required",
      confirmationToken,
      preview: {
        mode: input.mode ?? "new",
        to: payload.to,
        cc: payload.cc ?? [],
        bcc: payload.bcc ?? [],
        subject: payload.subject,
        text: payload.text,
        html: payload.html ?? null,
        warnings: previewWarnings(
          payload.html,
          attachmentTotalBytes,
          this.options.config.security.maxTotalAttachmentBytes
        ),
        attachmentTotalBytes,
        maxAttachmentBytes: this.options.config.security.maxAttachmentBytes,
        maxTotalAttachmentBytes:
          this.options.config.security.maxTotalAttachmentBytes,
        attachments: (payload.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType ?? "application/octet-stream",
          size: attachment.content.length
        }))
      }
    };
  }

  private async updateInternal(input: UpdateInput) {
    this.assertUpdateAllowed();
    if (input.messageRefs.length === 0) {
      throw new AppError("INVALID_INPUT", "At least one message reference is required");
    }

    const failures: Array<{
      messageRef: string;
      code: string;
      message: string;
      retryable: boolean;
    }> = [];
    let updated = 0;
    let openedFolder: string | null = null;
    let openedUidValidity: string | null = null;
    const existingByRef = new Map<string, Set<number>>();
    const preflightErrors = new Map<string, AppError>();

    const uniqueRefs = [...new Set(input.messageRefs)];
    const decodedRefs: Array<{
      messageRef: string;
      ref: { folder: string; uidValidity: string; uid: number };
    }> = [];
    for (const messageRef of uniqueRefs) {
      try {
        decodedRefs.push({ messageRef, ref: decodeMessageRef(messageRef) });
      } catch (error) {
        preflightErrors.set(
          messageRef,
          error instanceof AppError
            ? error
            : new AppError("INVALID_INPUT", "Invalid message reference")
        );
      }
    }

    for (const item of decodedRefs) {
      const key = `${item.ref.folder}\0${item.ref.uidValidity}`;
      if (!existingByRef.has(key)) {
        const current = await this.options.imap.openFolder(item.ref.folder);
        if (current.uidValidity !== item.ref.uidValidity) {
          continue;
        }
        const sameFolder = decodedRefs.filter(
          (candidate) =>
            candidate.ref.folder === item.ref.folder &&
            candidate.ref.uidValidity === item.ref.uidValidity
        );
        existingByRef.set(
          key,
          await this.options.imap.existingUids(
            sameFolder.map((candidate) => candidate.ref.uid)
          )
        );
      }
    }

    for (const messageRef of uniqueRefs) {
      const itemStartedAt = Date.now();
      let auditedRef: { folder: string; uid: number } | null = null;
      try {
        const preflightError = preflightErrors.get(messageRef);
        if (preflightError) {
          throw preflightError;
        }
        const ref = decodeMessageRef(messageRef);
        auditedRef = { folder: ref.folder, uid: ref.uid };
        if (openedFolder !== ref.folder || openedUidValidity !== ref.uidValidity) {
          const current = await this.options.imap.openFolder(ref.folder);
          openedFolder = ref.folder;
          openedUidValidity = current.uidValidity;
        }

        if (openedUidValidity !== ref.uidValidity) {
          throw new AppError("STALE_MESSAGE_REF", "Mailbox UIDVALIDITY changed");
        }

        const existing = existingByRef.get(
          `${ref.folder}\0${ref.uidValidity}`
        );
        if (!existing || !existing.has(ref.uid)) {
          throw new AppError(
            "MAIL_NOT_FOUND",
            "Message no longer exists in this folder"
          );
        }

        switch (input.action) {
          case "mark_read":
            await this.options.imap.updateFlags(ref.uid, "add", ["\\Seen"]);
            break;
          case "mark_unread":
            await this.options.imap.updateFlags(ref.uid, "remove", ["\\Seen"]);
            break;
          case "flag":
            await this.options.imap.updateFlags(ref.uid, "add", ["\\Flagged"]);
            break;
          case "unflag":
            await this.options.imap.updateFlags(ref.uid, "remove", ["\\Flagged"]);
            break;
          case "move":
          case "archive":
          case "trash": {
            const target = await this.resolveTargetFolder(input.targetFolder, input.action);
            await this.options.imap.moveMessage(ref.uid, target);
            break;
          }
        }

        updated += 1;
        await this.writeAudit({
          tool: "mail_update",
          action: input.action,
          result: "success",
          folder: ref.folder,
          uid: ref.uid,
          durationMs: Date.now() - itemStartedAt
        });
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unknown error");
        await this.writeAudit({
          tool: "mail_update",
          action: input.action,
          result: "failure",
          ...(auditedRef ?? {}),
          durationMs: Date.now() - itemStartedAt,
          errorCode: appError.code
        });
        failures.push({
          messageRef,
          code: appError.code,
          message: appError.message,
          retryable: appError.retryable
        });
      }
    }

    return {
      updated,
      failed: failures,
      action: input.action
    };
  }

  async close(): Promise<void> {
    try {
      await this.options.imap.close();
    } finally {
      this.options.smtp.close();
    }
  }

  private async resolveSendInput(
    input: SendInput,
    options: { allowIncomplete?: boolean } = {}
  ): Promise<OutgoingMessage> {
    const mode = input.mode ?? "new";
    const allowIncomplete = options.allowIncomplete ?? false;
    rejectHeaderInjection(input.subject, "subject");
    const parsedAttachments = (input.attachments ?? []).map((attachment) => ({
      filename: sanitizeFilename(attachment.filename),
      contentType: attachment.contentType,
      content: decodeAttachment(attachment.contentBase64)
    }));

    if (mode === "new") {
      if (
        !allowIncomplete &&
        (!input.to?.length ||
          !input.subject?.trim() ||
          (!input.text?.trim() && !input.html?.trim()))
      ) {
        throw new AppError(
          "INVALID_INPUT",
          "New messages require to, subject and at least one of text or html"
        );
      }
      const to = normalizeRecipientList(input.to ?? []);
      const cc = normalizeRecipientList(input.cc ?? []);
      const bcc = normalizeRecipientList(input.bcc ?? []);

      return this.validateAttachments({
        from: this.options.config.account.email,
        to,
        cc: cc.length > 0 ? cc : undefined,
        bcc: bcc.length > 0 ? bcc : undefined,
        subject: input.subject ?? "",
        text: input.text?.trim() ? input.text : "",
        html: input.html,
        attachments: parsedAttachments
      });
    }

    if (!input.messageRef) {
      throw new AppError("INVALID_INPUT", "Reply and forward modes require messageRef");
    }

    this.assertReadAllowed();
    const { normalized } = await this.loadMessage(input.messageRef);
    const original =
      mode === "forward"
        ? [normalized.text, normalized.signature, normalized.quotedHistory]
            .filter((value): value is string => Boolean(value))
            .join("\n\n")
        : normalized.text;
    const subject = input.subject?.trim()
      ? input.subject
      : withSubjectPrefix(normalized.subject, mode === "forward" ? "forward" : "reply");
    const body = input.text?.trim() ?? "";
    const text =
      input.includeOriginal === false
        ? body
        : `${body}\n\n--- Original message ---\n${original}`.trim();
    const references = [
      ...normalized.references,
      ...(normalized.messageId ? [normalized.messageId] : [])
    ].filter((value, index, values) => values.indexOf(value) === index);
    const accountEmail = this.options.config.account.email.toLowerCase();
    const normalizeRecipients = (
      addresses: string[],
      excludeAccount = false
    ): string[] =>
      [...new Set(addresses.map((address) => address.trim()).filter(Boolean))].filter(
        (address) => !excludeAccount || address.toLowerCase() !== accountEmail
      );

    const replySource = (
      normalized.replyTo.length > 0 ? normalized.replyTo : normalized.from
    ).map((address) => address.address);
    const replySourceRecipients = normalizeRecipients(replySource);
    const replySourceWithoutAccount = replySourceRecipients.filter(
      (address) => address.toLowerCase() !== accountEmail
    );
    const originalRecipients = normalizeRecipients(
      normalized.to.map((address) => address.address)
    ).filter((address) => address.toLowerCase() !== accountEmail);
    const to =
      mode === "forward"
        ? normalizeRecipients(input.to ?? [])
        : input.to
          ? normalizeRecipients(input.to)
          : replySourceWithoutAccount.length > 0
            ? replySourceWithoutAccount
            : originalRecipients;

    const derivedReplyAllRecipients = normalizeRecipients(
      normalized.to
        .concat(normalized.cc)
        .map((address) => address.address)
    ).filter((address) => address.toLowerCase() !== accountEmail);
    const cc =
      mode === "reply_all"
        ? (input.cc
            ? normalizeRecipients(input.cc)
            : derivedReplyAllRecipients
          ).filter(
            (address) =>
              !to.some((recipient) => recipient.toLowerCase() === address.toLowerCase())
          )
        : normalizeRecipients(input.cc ?? []);

    if (to.length === 0 && !allowIncomplete) {
      throw new AppError("INVALID_INPUT", "No recipient was found for this message");
    }

    const forwardedAttachments =
      mode === "forward" && input.includeOriginalAttachments !== false
        ? normalized.attachments.map((attachment) => ({
            filename: sanitizeFilename(attachment.filename),
            contentType: attachment.contentType,
            content: attachment.content
          }))
        : [];

    return this.validateAttachments({
      from: this.options.config.account.email,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc:
        normalizeRecipients(input.bcc ?? []).length > 0
          ? normalizeRecipients(input.bcc ?? [])
          : undefined,
      subject,
      text,
      html: input.html,
      inReplyTo: mode === "forward" ? undefined : normalized.messageId ?? undefined,
      references: mode === "forward" ? undefined : references,
      attachments: [...parsedAttachments, ...forwardedAttachments]
    });
  }

  private validateAttachments(message: OutgoingMessage): OutgoingMessage {
    const attachments = message.attachments ?? [];
    if (attachments.length > 100) {
      throw new AppError(
        "INVALID_INPUT",
        "A message cannot contain more than 100 attachments"
      );
    }
    const totalSize = attachments.reduce((total, item) => total + item.content.length, 0);
    if (totalSize > this.options.config.security.maxTotalAttachmentBytes) {
      throw new AppError("ATTACHMENT_TOO_LARGE", "Total attachment size exceeds configured limit", {
        details: { size: totalSize, limit: this.options.config.security.maxTotalAttachmentBytes }
      });
    }

    for (const attachment of attachments) {
      if (attachment.content.length > this.options.config.security.maxAttachmentBytes) {
        throw new AppError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured size limit", {
          details: {
            filename: attachment.filename,
            size: attachment.content.length,
            limit: this.options.config.security.maxAttachmentBytes
          }
        });
      }
    }

    return message;
  }

  private async maybeSaveSent(raw: Buffer, message: OutgoingMessage): Promise<void> {
    if (this.options.config.send.saveSent !== "always") {
      return;
    }

    this.folderCache = await this.options.imap.listFolders();
    const sent = this.folderCache.find((folder) => folder.role === "sent");
    if (!sent) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Unable to resolve the Sent folder while save_sent is enabled",
        {
          details: {
            role: "sent",
            available: this.folderCache.map((folder) => folder.name)
          }
        }
      );
    }
    if (!sent.selectable) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "The resolved Sent folder is not selectable"
      );
    }

    await this.options.imap.append(sent.name, raw, ["\\Seen"]);
  }

  private async draftInternal(input: DraftInput): Promise<Record<string, unknown>> {
    this.assertDraftAllowed();

    const payload = await this.resolveSendInput(
      {
        mode: input.mode,
        messageRef: input.messageRef,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        includeOriginal: input.includeOriginal,
        includeOriginalAttachments: input.includeOriginalAttachments,
        attachments: input.attachments
      },
      { allowIncomplete: true }
    );

    const drafts = await this.resolveDraftFolder();
    const raw = await this.options.smtp.compile(payload);

    let replaced: ResolvedMessage | null = null;
    if (input.messageRefToUpdate) {
      replaced = decodeMessageRef(input.messageRefToUpdate);
      const snapshot = await this.options.imap.openFolder(replaced.folder);
      if (snapshot.uidValidity !== replaced.uidValidity) {
        throw new AppError(
          "STALE_MESSAGE_REF",
          "Mailbox UIDVALIDITY changed; refresh the draft reference"
        );
      }
    }

    // Write the replacement first so a failure cannot lose the existing draft.
    await this.options.imap.append(drafts.name, raw, ["\\Draft"]);
    if (replaced) {
      const trash = this.folderCache?.find((folder) => folder.role === "trash");
      if (trash?.selectable) {
        await this.options.imap.moveMessage(replaced.uid, trash.name);
      }
    }

    return {
      status: "saved",
      folder: drafts.name,
      subject: payload.subject,
      to: payload.to,
      cc: payload.cc ?? [],
      bcc: payload.bcc ?? [],
      attachment_count: payload.attachments?.length ?? 0,
      ...(replaced ? { replaced: true } : {})
    };
  }

  private async resolveDraftFolder(): Promise<FolderInfo> {
    this.folderCache ??= await this.options.imap.listFolders();
    const drafts = this.folderCache.find(
      (folder) => folder.role === "drafts" || folder.role === "draft"
    );
    if (!drafts) {
      throw new AppError("FOLDER_NOT_FOUND", "Unable to resolve the Drafts folder", {
        details: {
          role: "drafts",
          available: this.folderCache.map((folder) => folder.name)
        }
      });
    }
    if (!drafts.selectable) {
      throw new AppError("FOLDER_NOT_FOUND", "The resolved Drafts folder is not selectable");
    }
    return drafts;
  }

  private async resolveTargetFolder(
    target: string | undefined,
    action: UpdateAction
  ): Promise<string> {
    if (action === "move" && target?.trim()) {
      this.folderCache ??= await this.options.imap.listFolders();
      const exact = this.folderCache.find((folder) => folder.name === target);
      if (!exact) {
        throw new AppError("FOLDER_NOT_FOUND", `Folder not found: ${target}`, {
          details: {
            requested: target,
            available: this.folderCache.map((folder) => folder.name)
          }
        });
      }
      if (!exact.selectable) {
        throw new AppError(
          "INVALID_INPUT",
          `Folder cannot receive messages because it is not selectable: ${target}`
        );
      }
      return exact.name;
    }

    if (action === "move" && !target?.trim()) {
      throw new AppError("INVALID_INPUT", "Moving a message requires targetFolder");
    }

    const role = action === "archive" ? "archive" : action === "trash" ? "trash" : null;
    this.folderCache ??= await this.options.imap.listFolders();
    const folder = this.folderCache.find((candidate) => candidate.role === role);
    if (!folder) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        `Unable to resolve the ${role ?? "target"} folder; call mail_folders first`,
        {
          details: {
            role,
            available: this.folderCache.map((candidate) => candidate.name)
          }
        }
      );
    }

    return folder.name;
  }

  private async audited<T>(
    tool: string,
    action: string,
    operation: () => Promise<T>,
    context: { folder?: string; uid?: number } = {},
    classify?: (result: T) => {
      result: "success" | "failure";
      errorCode?: string;
    }
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await this.run(operation);
      const classification = classify?.(result) ?? { result: "success" as const };
      await this.writeAudit({
        tool,
        action,
        result: classification.result,
        ...(classification.errorCode
          ? { errorCode: classification.errorCode }
          : {}),
        ...context,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      await this.writeAudit({
        tool,
        action,
        result: "failure",
        ...context,
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof AppError ? error.code : "INTERNAL_ERROR"
      });
      throw error;
    }
  }

  private async writeAudit(event: {
    tool: string;
    action: string;
    result: "success" | "failure";
    errorCode?: string;
    folder?: string;
    uid?: number;
    durationMs?: number;
  }): Promise<void> {
    try {
      await this.options.audit.write(event);
    } catch {
      // Audit logging is best-effort and must not change the action outcome.
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async summariesFor(
    folder: string,
    uidValidity: string,
    uids: number[],
    options: { includeSnippet?: boolean | undefined } = {}
  ): Promise<MessageSummary[]> {
    const rows = await this.options.imap.fetchSummaries(uids, {
      includeSnippet: options.includeSnippet
    });
    return rows.map((row) => {
      const envelope = row.envelope;
      return {
        messageRef: encodeMessageRef({
          folder,
          uidValidity,
          uid: row.uid
        }),
        subject: envelope?.subject ?? "(no subject)",
        from:
          envelope?.from?.[0]?.address
            ? {
                name: envelope.from[0].name ?? null,
                address: envelope.from[0].address
              }
            : null,
        to: (envelope?.to ?? [])
          .filter((address): address is { address: string; name?: string | null } =>
            Boolean(address.address)
          )
          .map((address) => ({
            name: address.name ?? null,
            address: address.address
          })),
        date: safeIsoDate(envelope?.date, row.internalDate),
        unread: !row.flags.has("\\Seen"),
        flagged: row.flags.has("\\Flagged"),
        hasAttachments: row.hasAttachments,
        attachmentCount: row.attachmentCount,
        snippet:
          options.includeSnippet === false
            ? null
            : row.snippetText
              ? row.snippetText.slice(0, 200)
              : null
      };
    });
  }

  private async loadMessage(
    messageRef: string
  ): Promise<{
    ref: ResolvedMessage;
    normalized: NormalizedMessage;
    flags: Set<string>;
  }> {
    const ref = decodeMessageRef(messageRef);
    const snapshot = await this.options.imap.openFolder(ref.folder);
    if (snapshot.uidValidity !== ref.uidValidity) {
      throw new AppError(
        "STALE_MESSAGE_REF",
        "Mailbox UIDVALIDITY changed; search again before using this message reference"
      );
    }

    const fetched = await this.options.imap.fetchMessage(ref.uid);
    if (!fetched || fetched.source.length === 0) {
      throw new AppError("MAIL_NOT_FOUND", "Message source was not returned by IMAP");
    }

    return {
      ref,
      flags: fetched.flags,
      normalized: await normalizeMessage(fetched.source, {
        allowRemoteImages: this.options.config.security.allowRemoteImages
      })
    };
  }

  private attachmentSummary(attachment: {
    attachmentId: string;
    filename: string;
    contentType: string;
    size: number;
    disposition?: string | null;
    contentId?: string | null;
  }): AttachmentSummary {
    return {
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.disposition ?? null,
      contentId: attachment.contentId ?? null
    };
  }

  private toAgentContext(input: GetInput, bundle: {
    ref: ResolvedMessage;
    normalized: NormalizedMessage;
  }): AgentContext {
    const maxChars = this.resolveBodyMaxChars(input, "agent");
    const offset = this.resolveBodyOffset(input, "agent");
    const text = bundle.normalized.text.slice(offset, offset + maxChars);
    const nextOffset = offset + text.length;
    const nextCursor =
      nextOffset < bundle.normalized.text.length
        ? encodeBodyCursor({
            messageRef: input.messageRef,
            mode: "agent",
            offset: nextOffset,
            maxChars
          })
        : null;
    const quotedHistory = this.limitOptionalText(
      bundle.normalized.quotedHistory,
      maxChars
    );
    const signature = this.limitOptionalText(
      bundle.normalized.signature,
      maxChars
    );
    const htmlClean = this.limitOptionalText(
      bundle.normalized.htmlClean,
      maxChars
    );
    const attachments =
      input.includeAttachments === false
        ? []
        : bundle.normalized.attachments.map((attachment) =>
            this.attachmentSummary(attachment)
          );
    const warnings: string[] = [];
    if (bundle.normalized.htmlClean !== null) {
      warnings.push("HTML was sanitized before being returned");
      if (bundle.normalized.remoteResourcesRemoved) {
        warnings.push("Remote HTML resources were removed");
      }
    }
    if (bundle.normalized.dateMissing) {
      warnings.push("Message date was missing; a fallback timestamp was used");
    }
    if (
      input.includeAttachments === false &&
      bundle.normalized.attachments.length > 0
    ) {
      warnings.push("Attachment metadata was omitted by request");
    }

    return {
      messageRef: input.messageRef,
      threadRef: threadRootRef(bundle.normalized),
      subject: bundle.normalized.subject,
      from: bundle.normalized.from,
      to: bundle.normalized.to,
      cc: bundle.normalized.cc,
      replyTo: bundle.normalized.replyTo,
      date: bundle.normalized.date,
      text,
      signature: signature.value,
      signatureTruncated: signature.truncated,
      quotedHistory: quotedHistory.value,
      quotedHistoryTruncated: quotedHistory.truncated,
      htmlClean: htmlClean.value,
      htmlCleanTruncated: htmlClean.truncated,
      attachments,
      links: input.includeLinks === false ? [] : bundle.normalized.links,
      warnings,
      truncated: nextOffset < bundle.normalized.text.length,
      nextCursor,
      isUntrusted: true
    };
  }

  private resolveBodyOffset(
    input: GetInput,
    mode: "text" | "agent"
  ): number {
    if (!input.cursor) {
      return 0;
    }

    const cursor = decodeBodyCursor(input.cursor);
    if (cursor.messageRef !== input.messageRef) {
      throw new AppError("INVALID_INPUT", "Body cursor belongs to another message");
    }
    if (cursor.mode !== mode) {
      throw new AppError(
        "INVALID_INPUT",
        "Body cursor belongs to another mail_get mode"
      );
    }
    if (
      input.maxChars !== undefined &&
      input.maxChars !== cursor.maxChars
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Body cursor must be used with the same max_chars value"
      );
    }

    return cursor.offset;
  }

  private assertNoBodyCursor(
    mode: "metadata" | "thread",
    cursor: string | null | undefined
  ): void {
    if (cursor) {
      throw new AppError(
        "INVALID_INPUT",
        `Body cursor is not supported in ${mode} mode`
      );
    }
  }

  private resolveBodyMaxChars(
    input: GetInput,
    mode: "text" | "agent"
  ): number {
    if (input.cursor) {
      const cursor = decodeBodyCursor(input.cursor);
      if (cursor.mode !== mode) {
        throw new AppError(
          "INVALID_INPUT",
          "Body cursor belongs to another mail_get mode"
        );
      }
      return cursor.maxChars;
    }

    return Math.min(Math.max(input.maxChars ?? 20_000, 1), 200_000);
  }

  private limitOptionalText(
    value: string | null,
    budget: number
  ): { value: string | null; truncated: boolean } {
    if (!value || budget <= 0) {
      return {
        value: budget <= 0 && value ? "" : value,
        truncated: budget <= 0 && Boolean(value)
      };
    }

    return {
      value: value.slice(0, budget),
      truncated: value.length > budget
    };
  }

  private async toThreadContext(
    input: GetInput,
    bundle: { ref: ResolvedMessage; normalized: NormalizedMessage }
  ): Promise<ThreadContext> {
    const currentId = bundle.normalized.messageId;
    const referenceIds = new Set(
      [currentId, ...bundle.normalized.references, bundle.normalized.inReplyTo]
        .filter((value): value is string => Boolean(value))
    );
    const threadRootId = threadRootRef(bundle.normalized);
    const candidateUids = new Set<number>([bundle.ref.uid]);
    const maxMessages = 50;
    let droppedCandidates = false;

    for (const referencedId of referenceIds) {
      const uids = await this.options.imap.search({
        messageId: referencedId
      });
      if (uids.length > maxMessages) {
        droppedCandidates = true;
      }
      for (const uid of uids.slice(0, maxMessages)) {
        candidateUids.add(uid);
        if (candidateUids.size >= maxMessages) {
          droppedCandidates = true;
          break;
        }
      }
      if (candidateUids.size >= maxMessages) {
        break;
      }
    }

    for (const referenceId of referenceIds) {
      const replies = await this.options.imap.search({
        referencesMessageId: referenceId
      });
      if (replies.length > maxMessages) {
        droppedCandidates = true;
      }
      for (const uid of replies.slice(0, maxMessages)) {
        candidateUids.add(uid);
        if (candidateUids.size >= maxMessages) {
          droppedCandidates = true;
          break;
        }
      }
      const directReplies = await this.options.imap.search({
        inReplyToMessageId: referenceId
      });
      if (directReplies.length > maxMessages) {
        droppedCandidates = true;
      }
      for (const uid of directReplies.slice(0, maxMessages)) {
        candidateUids.add(uid);
        if (candidateUids.size >= maxMessages) {
          droppedCandidates = true;
          break;
        }
      }
      if (candidateUids.size >= maxMessages) {
        droppedCandidates = true;
        break;
      }
    }

    const fetched = await this.options.imap.fetchMessages([...candidateUids]);
    const candidateIdList = new Set<string>(referenceIds);
    const totalBudget = Math.min(
      Math.max(input.maxChars ?? 20_000, 1),
      200_000
    );
    let remainingBudget = totalBudget;
    let contentTruncated = false;
    const normalized = await Promise.all(
      fetched.map(async (message) => ({
        uid: message.uid,
        value: await normalizeMessage(message.source, {
          allowRemoteImages: this.options.config.security.allowRemoteImages
        })
      }))
    );
    const messages = normalized
      .filter((item) => {
        const id = item.value.messageId;
        if (!id) {
          return item.uid === bundle.ref.uid;
        }
        const itemLinks = new Set(
          [id, ...item.value.references, item.value.inReplyTo].filter(
            (value): value is string => Boolean(value)
          )
        );
        return (
          candidateIdList.has(id) ||
          [...candidateIdList].some((reference) => itemLinks.has(reference)) ||
          [...referenceIds].some((reference) => itemLinks.has(reference))
        );
      })
      .sort((left, right) => {
        const leftDepth =
          left.value.references.length + (left.value.inReplyTo ? 1 : 0);
        const rightDepth =
          right.value.references.length + (right.value.inReplyTo ? 1 : 0);
        if (leftDepth !== rightDepth) {
          return leftDepth - rightDepth;
        }

        return left.value.date.localeCompare(right.value.date);
      })
      .map((item): ThreadMessage => {
        const messageBudget = Math.max(remainingBudget, 0);
        const text = item.value.text.slice(0, messageBudget);
        remainingBudget -= text.length;
        if (item.value.text.length > text.length) {
          contentTruncated = true;
        }
        return {
          messageRef: encodeMessageRef({
            folder: bundle.ref.folder,
            uidValidity: bundle.ref.uidValidity,
            uid: item.uid
          }),
          messageId: item.value.messageId,
          inReplyTo: item.value.inReplyTo,
          references: item.value.references,
          subject: item.value.subject,
          from: item.value.from,
          to: item.value.to,
          date: item.value.date,
          text,
          truncated: item.value.text.length > text.length,
          isUntrusted: true
        };
      });

    return {
      threadRef: threadRootId,
      messages,
      truncated: droppedCandidates || contentTruncated,
      isUntrusted: true
    };
  }

  private assertReadAllowed(): void {
    if (!this.options.config.permissions.read) {
      throw new AppError("PERMISSION_DENIED", "Read permission is disabled");
    }
  }

  private assertDraftAllowed(): void {
    if (!this.options.config.permissions.draft && !this.options.config.permissions.update) {
      throw new AppError("PERMISSION_DENIED", "Draft permission is disabled");
    }
  }

  private assertUpdateAllowed(): void {
    if (!this.options.config.permissions.update) {
      throw new AppError("PERMISSION_DENIED", "Update permission is disabled");
    }
  }

  private assertSendAllowed(): void {
    if (!this.options.config.permissions.send) {
      throw new AppError("PERMISSION_DENIED", "Send permission is disabled");
    }
  }
}

function decodeAttachment(value: string): Buffer {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new AppError("INVALID_INPUT", "Attachment content is not valid base64");
  }

  try {
    return Buffer.from(value, "base64");
  } catch (error) {
    throw new AppError("INVALID_INPUT", "Attachment content is not valid base64", {
      cause: error
    });
  }
}

function normalizeRecipientList(addresses: string[]): string[] {
  return [
    ...new Set(
      addresses
        .map((address) => address.trim())
        .filter(Boolean)
    )
  ];
}

function rejectHeaderInjection(
  value: string | undefined,
  field: string
): void {
  if (value && /[\r\n]/.test(value)) {
    throw new AppError(
      "INVALID_INPUT",
      `${field} must not contain line breaks`
    );
  }
}

function withSubjectPrefix(
  subject: string,
  kind: "reply" | "forward"
): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return kind === "reply" ? "Re:" : "Fwd:";
  }
  if (kind === "reply") {
    const match = /^(?:(?:re|aw|sv):\s*|回复[:：]\s*)+/i.exec(trimmed);
    return match
      ? `Re: ${trimmed.slice(match[0].length).trim()}`
      : `Re: ${trimmed}`;
  }

  const match = /^(?:(?:fwd?|wg):\s*|转发[:：]\s*)+/i.exec(trimmed);
  return match
    ? `Fwd: ${trimmed.slice(match[0].length).trim()}`
    : `Fwd: ${trimmed}`;
}

function previewWarnings(
  html: string | undefined,
  attachmentTotalBytes = 0,
  maxTotalAttachmentBytes = 0
): string[] {
  const warnings = new Set<string>();

  if (html) {
    if (/<script\b/i.test(html)) {
      warnings.add("HTML contains script content");
    }
    if (/<form\b/i.test(html)) {
      warnings.add("HTML contains a form");
    }
    if (/\son[a-z]+\s*=/i.test(html)) {
      warnings.add("HTML contains inline event handlers");
    }
    if (/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
      warnings.add("HTML references remote resources");
    }
  }

  if (
    maxTotalAttachmentBytes > 0 &&
    attachmentTotalBytes > maxTotalAttachmentBytes * 0.8
  ) {
    warnings.add("Attachments are close to the configured total size limit");
  }

  return [...warnings];
}

function statusWarning(channel: "IMAP" | "SMTP", error: unknown): string {
  if (error instanceof AppError) {
    switch (error.code) {
      case "AUTH_FAILED":
        return `${channel} authentication failed`;
      case "TIMEOUT":
        return `${channel} connection timed out`;
      case "NETWORK_ERROR":
        return `${channel} network error`;
      default:
        return `${channel} is unavailable`;
    }
  }

  return `${channel} is unavailable`;
}

function threadRootRef(message: NormalizedMessage): string | null {
  return (
    message.references[0] ??
    message.inReplyTo ??
    message.messageId
  );
}

function safeIsoDate(...candidates: Array<Date | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && !Number.isNaN(candidate.getTime())) {
      return toLocalIsoString(candidate);
    }
  }

  return toLocalIsoString(new Date());
}

export function toLocalIsoString(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");
  const local = new Date(value.getTime() + offsetMinutes * 60_000);
  return `${local.toISOString().slice(0, -1)}${sign}${hours}:${minutes}`;
}

function validateSearchDates(
  since: string | undefined,
  before: string | undefined
): void {
  const sinceTime = parseSearchDate(since, "since");
  const beforeTime = parseSearchDate(before, "before");
  if (sinceTime !== null && beforeTime !== null && beforeTime <= sinceTime) {
    throw new AppError("INVALID_INPUT", "before must be later than since");
  }
}

function parseSearchDate(value: string | undefined, field: string): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("INVALID_INPUT", `Invalid ${field} date: ${value}`);
  }

  return parsed.getTime();
}

function resolveListDateRange(input: ListInput): { since?: string | undefined; before?: string | undefined } {
  if (input.recentDays === undefined) {
    return { since: input.since, before: input.before };
  }

  if (!Number.isInteger(input.recentDays) || input.recentDays <= 0) {
    throw new AppError("INVALID_INPUT", "recent_days must be a positive integer");
  }

  if (input.since || input.before) {
    throw new AppError(
      "INVALID_INPUT",
      "recent_days cannot be combined with since or before"
    );
  }

  const since = new Date(Date.now() - input.recentDays * 24 * 60 * 60 * 1000);
  return { since: since.toISOString() };
}
