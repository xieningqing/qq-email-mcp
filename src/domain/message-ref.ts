import { AppError } from "../errors.js";

const MAX_UID = 0xffffffff;
const MAX_TOKEN_LENGTH = 8192;

export interface MessageRefPayload {
  version: 1;
  folder: string;
  uidValidity: string;
  uid: number;
}

export interface CursorPayload {
  version: 1;
  folder: string;
  uidValidity: string;
  lastUid: number;
  queryHash: string;
}

export interface BodyCursorPayload {
  version: 1;
  messageRef: string;
  mode: "text" | "agent";
  offset: number;
  maxChars: number;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(value: string, label: string): T {
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new AppError("INVALID_INPUT", `Invalid ${label}`);
  }

  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch (error) {
    throw new AppError("INVALID_INPUT", `Invalid ${label}`, {
      cause: error
    });
  }
}

export function encodeMessageRef(payload: Omit<MessageRefPayload, "version">): string {
  return encode({ version: 1, ...payload });
}

export function decodeMessageRef(value: string): MessageRefPayload {
  const payload = decode<Partial<MessageRefPayload>>(value, "message reference");
  if (
    payload.version !== 1 ||
    typeof payload.folder !== "string" ||
    typeof payload.uidValidity !== "string" ||
    !Number.isSafeInteger(payload.uid) ||
    (payload.uid ?? 0) <= 0 ||
    (payload.uid ?? 0) > MAX_UID
  ) {
    throw new AppError("INVALID_INPUT", "Invalid message reference");
  }

  return payload as MessageRefPayload;
}

export function encodeCursor(payload: Omit<CursorPayload, "version">): string {
  return encode({ version: 1, ...payload });
}

export function decodeCursor(value: string): CursorPayload {
  const payload = decode<Partial<CursorPayload>>(value, "cursor");
  if (
    payload.version !== 1 ||
    typeof payload.folder !== "string" ||
    typeof payload.uidValidity !== "string" ||
    typeof payload.queryHash !== "string" ||
    !Number.isSafeInteger(payload.lastUid) ||
    (payload.lastUid ?? 0) <= 0 ||
    (payload.lastUid ?? 0) > MAX_UID
  ) {
    throw new AppError("INVALID_INPUT", "Invalid cursor");
  }

  return payload as CursorPayload;
}

export function encodeBodyCursor(
  payload: Omit<BodyCursorPayload, "version">
): string {
  return encode({ version: 1, ...payload });
}

export function decodeBodyCursor(value: string): BodyCursorPayload {
  const payload = decode<Partial<BodyCursorPayload>>(value, "body cursor");
  if (
    payload.version !== 1 ||
    typeof payload.messageRef !== "string" ||
    (payload.mode !== "text" && payload.mode !== "agent") ||
    !Number.isSafeInteger(payload.offset) ||
    (payload.offset ?? -1) < 0 ||
    !Number.isSafeInteger(payload.maxChars) ||
    (payload.maxChars ?? 0) <= 0
  ) {
    throw new AppError("INVALID_INPUT", "Invalid body cursor");
  }

  return payload as BodyCursorPayload;
}
