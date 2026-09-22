import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAuditLogger, NoopAuditLogger } from "../../src/security/audit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("FileAuditLogger", () => {
  it("writes one redacted JSON line per event", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "qq-mail-audit-"));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, "nested", "audit.jsonl");
    const logger = new FileAuditLogger(logPath);

    await logger.write({
      tool: "mail_get",
      action: "read_agent",
      result: "success",
      folder: "INBOX",
      uid: 42,
      durationMs: 12
    });
    await logger.write({
      tool: "mail_send",
      action: "send",
      result: "failure",
      errorCode: "TIMEOUT",
      durationMs: 30
    });

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      tool: "mail_get",
      action: "read_agent",
      result: "success",
      folder: "INBOX",
      uid: 42,
      durationMs: 12
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      tool: "mail_send",
      result: "failure",
      errorCode: "TIMEOUT"
    });
  });

  it("does not create a file when disabled", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "qq-mail-audit-"));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, "audit.jsonl");
    const logger = new FileAuditLogger(logPath, false);

    await logger.write({
      tool: "mail_list",
      action: "list_messages",
      result: "success"
    });

    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("accepts events through the no-op logger", async () => {
    const logger = new NoopAuditLogger();

    await expect(
      logger.write({ tool: "mail_list", action: "list", result: "success" })
    ).resolves.toBeUndefined();
  });
});
