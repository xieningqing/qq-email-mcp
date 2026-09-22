import { describe, expect, it } from "vitest";
import {
  decodeBodyCursor,
  decodeCursor,
  decodeMessageRef,
  encodeBodyCursor,
  encodeCursor,
  encodeMessageRef
} from "../../src/domain/message-ref.js";
import { AppError } from "../../src/errors.js";

describe("message references", () => {
  it("round trips folder, uid validity and uid", () => {
    const ref = encodeMessageRef({
      folder: "INBOX",
      uidValidity: "123456",
      uid: 42
    });

    expect(decodeMessageRef(ref)).toEqual({
      version: 1,
      folder: "INBOX",
      uidValidity: "123456",
      uid: 42
    });
  });

  it("rejects malformed references", () => {
    expect(() => decodeMessageRef("not-a-reference")).toThrow(AppError);
    const oversized = Buffer.from(
      JSON.stringify({
        version: 1,
        folder: "INBOX",
        uidValidity: "1",
        uid: 0x100000000
      })
    ).toString("base64url");
    expect(() => decodeMessageRef(oversized)).toThrow(AppError);
  });

  it("rejects oversized tokens before parsing", () => {
    expect(() => decodeMessageRef("a".repeat(9000))).toThrow(AppError);
    expect(() => decodeCursor("a".repeat(9000))).toThrow(AppError);
    expect(() => decodeBodyCursor("a".repeat(9000))).toThrow(AppError);
  });

  it("rejects a cursor with a UID above the IMAP range", () => {
    const oversized = Buffer.from(
      JSON.stringify({
        version: 1,
        folder: "INBOX",
        uidValidity: "1",
        lastUid: 0x100000000,
        queryHash: "abc"
      })
    ).toString("base64url");

    expect(() => decodeCursor(oversized)).toThrow(AppError);
  });

  it("round trips cursor state", () => {
    const cursor = encodeCursor({
      folder: "INBOX",
      uidValidity: "99",
      lastUid: 100,
      queryHash: "abc"
    });

    expect(decodeCursor(cursor)).toEqual({
      version: 1,
      folder: "INBOX",
      uidValidity: "99",
      lastUid: 100,
      queryHash: "abc"
    });
  });

  it("round trips a body cursor with its mail_get mode", () => {
    const cursor = encodeBodyCursor({
      messageRef: "opaque-ref",
      mode: "agent",
      offset: 20,
      maxChars: 20
    });

    expect(decodeBodyCursor(cursor)).toEqual({
      version: 1,
      messageRef: "opaque-ref",
      mode: "agent",
      offset: 20,
      maxChars: 20
    });
  });

  it("rejects a body cursor without a valid mode", () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        messageRef: "opaque-ref",
        offset: 0,
        maxChars: 20
      }),
      "utf8"
    ).toString("base64url");

    expect(() => decodeBodyCursor(cursor)).toThrow(AppError);
  });
});
