import sanitizeHtml from "sanitize-html";
import type { AddressObject, ParsedMail } from "mailparser";
import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import type { AttachmentSummary, MailAddress } from "../domain/mail.js";

export interface NormalizedAttachment extends AttachmentSummary {
  content: Buffer;
}

export interface NormalizedMessage {
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  date: string;
  dateMissing: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fullText: string;
  text: string;
  signature: string | null;
  quotedHistory: string | null;
  htmlClean: string | null;
  remoteResourcesRemoved: boolean;
  attachments: NormalizedAttachment[];
  links: string[];
}

const QUOTE_MARKERS: RegExp[] = [
  /On .+ wrote:/i,
  /On .+ at .+ wrote:/i,
  /在 .+写道[:：]/,
  /在 .+，.+写道[:：]/,
  /-----Original Message-----/i,
  /-----原始邮件-----/,
  /发件人[:：]\s*/,
  /From:\s*[^<\n]*<[^@\s<>]+@[^@\s<>]+>/i,
  /From:\s*[^@\s<>]+@[^@\s<>]+/i
];

function splitQuotedHistory(value: string): {
  current: string;
  quoted: string | null;
} {
  const normalized = normalizePlainText(value);
  let splitIndex = -1;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(normalized);
    if (match?.index !== undefined && (splitIndex === -1 || match.index < splitIndex)) {
      splitIndex = match.index;
    }
  }

  if (splitIndex <= 0) {
    return { current: normalized, quoted: null };
  }

  const current = normalized.slice(0, splitIndex).trim();
  const quoted = normalized.slice(splitIndex).trim();
  if (current.length < 20 || quoted.length < 20) {
    return { current: normalized, quoted: null };
  }

  return {
    current,
    quoted
  };
}

const SIGNATURE_MARKERS: RegExp[] = [
  /(?:^|\n)\s*--\s*(?:\n|$)/,
  /(?:^|\n)\s*(?:此致|顺祝商祺|祝好|谢谢)\s*(?:\n|$)/,
  /(?:^|\n)\s*(?:best regards|kind regards|regards|thanks|thank you)\s*(?:\n|$)/i
];

function splitSignature(value: string): {
  body: string;
  signature: string | null;
} {
  const normalized = normalizePlainText(value);
  let splitIndex = -1;
  for (const marker of SIGNATURE_MARKERS) {
    const match = marker.exec(normalized);
    if (match?.index !== undefined && (splitIndex === -1 || match.index < splitIndex)) {
      splitIndex = match.index + (match[0].startsWith("\n") ? 1 : 0);
    }
  }

  if (splitIndex <= 0) {
    return { body: normalized, signature: null };
  }

  const body = normalized.slice(0, splitIndex).trim();
  const signature = normalized.slice(splitIndex).trim();
  if (body.length < 20 || signature.length < 2) {
    return { body: normalized, signature: null };
  }

  return { body, signature };
}

export interface NormalizeOptions {
  allowRemoteImages?: boolean;
}

function addressList(
  value: AddressObject | AddressObject[] | undefined
): MailAddress[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) =>
    entry.value
      .filter((address) => Boolean(address.address))
      .map((address) => ({
        name: address.name || null,
        address: address.address as string
      }))
  );
}

function headerString(mail: ParsedMail, name: string): string | null {
  const value = mail.headers.get(name);
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(" ");
  }

  return null;
}

function rawHeaderValue(source: Buffer, name: string): string | null {
  const headerBlock = source
    .toString("utf8", 0, Math.min(source.length, 128 * 1024))
    .split(/\r?\n\r?\n/, 1)[0];
  if (!headerBlock) {
    return null;
  }

  const pattern = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`,
    "im"
  );
  const match = pattern.exec(headerBlock);
  return match?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() || null;
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(/\s+/))
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^<|>$/g, ""))
    .filter(Boolean);
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^<|>$/g, "");
}

function attachmentId(content: Buffer, filename: string): string {
  return createHash("sha256").update(filename).update("\0").update(content).digest("hex");
}

function cleanHtml(html: string, allowRemoteImages: boolean): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "html",
      "head",
      "body",
      "title",
      "img",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "blockquote",
      "pre",
      "code"
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title", "width", "height"],
      a: ["href", "title"],
      "*": ["style"]
    },
    allowedSchemes: ["http", "https", "mailto", "cid"],
    allowedSchemesByTag: {
      img: allowRemoteImages ? ["http", "https", "cid", "data"] : ["cid", "data"]
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
      "*": (tagName, attribs) => {
        if (allowRemoteImages || !attribs.style) {
          return { tagName, attribs };
        }

        return {
          tagName,
          attribs: {
            ...attribs,
            style: attribs.style.replace(
              /url\s*\(\s*['"]?(?:https?:|data:)[^)]*\)/gi,
              ""
            )
          }
        };
      }
    }
  });
}

function decodeHtmlEntities(value: string): string {
  return value
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
    });
}

function htmlToText(html: string): string {
  const decoded = decodeHtmlEntities(
    sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {}
  })
  );

  return decoded
    .replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ")
    .trim();
}

function extractLinks(html: string | false, text: string): string[] {
  const links = new Set<string>();
  const source = typeof html === "string" ? html : "";
  for (const match of source.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1] && isSafeLink(match[1])) {
      links.add(match[1]);
    }
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    if (match[0]) {
      links.add(match[0]);
    }
  }

  return [...links];
}

function isSafeLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /^(?:https?:|mailto:|cid:)/i.test(trimmed);
}

export async function normalizeMessage(
  source: Buffer,
  options: NormalizeOptions = {}
): Promise<NormalizedMessage> {
  const mail = await simpleParser(source);
  const rawDateHeader = rawHeaderValue(source, "Date");
  const parsedDate = rawDateHeader ? new Date(rawDateHeader) : null;
  const hasUsableDate =
    parsedDate !== null && !Number.isNaN(parsedDate.getTime());
  const allowRemoteImages = options.allowRemoteImages ?? false;
  const rawHtml = typeof mail.html === "string" ? mail.html : null;
  const htmlClean = rawHtml !== null ? cleanHtml(rawHtml, allowRemoteImages) : null;
  const remoteResourcesRemoved =
    !allowRemoteImages &&
    rawHtml !== null &&
    /(?:\bsrc|\bbackground|\bposter|\bstyle)\s*=|url\s*\(/i.test(rawHtml) &&
    /(?:https?:|data:)/i.test(rawHtml);
  const rawText = mail.text?.trim() || (typeof mail.html === "string" ? htmlToText(mail.html) : "");
  const fullText = normalizePlainText(rawText);
  const { current: textWithoutQuote, quoted } = splitQuotedHistory(fullText);
  const { body: current, signature } = splitSignature(textWithoutQuote);
  const attachments = mail.attachments.map((attachment) => {
    const filename = attachment.filename || "attachment.bin";
    return {
      attachmentId: attachmentId(attachment.content, filename),
      filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.contentDisposition || null,
      contentId: attachment.contentId || null,
      content: attachment.content
    };
  });

  return {
    subject: mail.subject ?? "",
    from: addressList(mail.from),
    to: addressList(mail.to),
    cc: addressList(mail.cc),
    bcc: addressList(mail.bcc),
    replyTo: addressList(mail.replyTo),
    date: (hasUsableDate ? parsedDate : new Date()).toISOString(),
    dateMissing: !hasUsableDate,
    messageId: normalizeMessageId(mail.messageId ?? headerString(mail, "message-id")),
    inReplyTo: normalizeMessageId(mail.inReplyTo ?? headerString(mail, "in-reply-to")),
    references: normalizeReferences(mail.references),
    fullText,
    text: current,
    signature,
    quotedHistory: quoted,
    htmlClean,
    remoteResourcesRemoved,
    attachments,
    links: extractLinks(mail.html, current)
  };
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ")
    .trim();
}
