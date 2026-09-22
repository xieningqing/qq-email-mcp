export type ErrorCode =
  | "CONFIG_MISSING"
  | "INVALID_CONFIG"
  | "AUTH_FAILED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "PERMISSION_DENIED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "INVALID_INPUT"
  | "MAIL_NOT_FOUND"
  | "STALE_MESSAGE_REF"
  | "FOLDER_NOT_FOUND"
  | "INVALID_ATTACHMENT_PATH"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_NOT_FOUND"
  | "UNSUPPORTED_ATTACHMENT"
  | "EXTRACTION_TIMEOUT"
  | "SMTP_SEND_FAILED"
  | "IMAP_OPERATION_FAILED"
  | "PARTIAL_UPDATE_FAILED"
  | "INTERNAL_ERROR";

export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
      retryable: false
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Unknown error",
    retryable: false
  };
}

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

export function networkFailureKind(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }

  const normalized = code.toUpperCase();
  if (DNS_ERROR_CODES.has(normalized)) {
    return "dns";
  }
  if (TLS_ERROR_CODES.has(normalized)) {
    return "tls";
  }
  if (
    normalized === "ECONNREFUSED" ||
    normalized === "ECONNRESET" ||
    normalized === "EPIPE" ||
    normalized === "EHOSTUNREACH" ||
    normalized === "ENETUNREACH" ||
    normalized === "ESOCKET"
  ) {
    return "connection";
  }

  return "network";
}
