import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "../../src/security/confirmation.js";
import { AppError } from "../../src/errors.js";

describe("ConfirmationStore", () => {
  it("consumes a matching token once", () => {
    const store = new ConfirmationStore();
    const token = store.create("fingerprint", { value: 1 });

    expect(store.consume(token, "fingerprint")).toEqual({ value: 1 });
    expect(() => store.consume(token, "fingerprint")).toThrow(AppError);
  });

  it("rejects consuming without a fingerprint", () => {
    const store = new ConfirmationStore();
    const token = store.create("fingerprint", { value: 1 });

    expect(() => store.consume(token, undefined as unknown as string)).toThrow(AppError);
  });

  it("rejects a mismatched payload", () => {
    const store = new ConfirmationStore();
    const token = store.create("first", "payload");

    expect(() => store.consume(token, "second")).toThrow(AppError);
  });

  it("expires old tokens", () => {
    const store = new ConfirmationStore(1);
    const token = store.create("fingerprint", "payload");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 10;

    try {
      expect(() => store.consume(token, "fingerprint")).toThrow(AppError);
    } finally {
      Date.now = originalNow;
    }
  });

  it("revokes a token before it can be consumed", () => {
    const store = new ConfirmationStore();
    const token = store.create("fingerprint", "payload");

    expect(store.revoke(token)).toBe(true);
    expect(() => store.consume(token, "fingerprint")).toThrow(AppError);
    expect(store.revoke(token)).toBe(false);
  });
});
