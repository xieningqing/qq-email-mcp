import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";

interface ConfirmationRecord<TPayload> {
  token: string;
  fingerprint: string;
  payload: TPayload;
  expiresAt: number;
  used: boolean;
}

export class ConfirmationStore<TPayload = unknown> {
  private readonly records = new Map<string, ConfirmationRecord<TPayload>>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  create(fingerprint: string, payload: TPayload): string {
    const token = randomUUID();
    const now = Date.now();
    this.prune(now);
    this.records.set(token, {
      token,
      fingerprint,
      payload,
      expiresAt: now + this.ttlMs,
      used: false
    });
    return token;
  }

  consume(token: string, fingerprint: string | ((payload: TPayload) => string)): TPayload {
    const now = Date.now();
    this.prune(now);
    const record = this.records.get(token);
    if (!record || record.used || record.expiresAt < now) {
      throw new AppError("CONFIRMATION_INVALID", "Confirmation token is missing or expired");
    }

    const expected =
      typeof fingerprint === "function" ? fingerprint(record.payload) : fingerprint;
    if (record.fingerprint !== expected) {
      throw new AppError("CONFIRMATION_INVALID", "Confirmation token does not match this action");
    }

    record.used = true;
    return record.payload;
  }


  revoke(token: string): boolean {
    return this.records.delete(token);
  }

  private prune(now: number): void {
    for (const [token, record] of this.records) {
      if (record.used || record.expiresAt < now) {
        this.records.delete(token);
      }
    }
  }
}
