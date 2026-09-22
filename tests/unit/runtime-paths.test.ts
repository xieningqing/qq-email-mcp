import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRuntimePaths } from "../../src/security/runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("verifyRuntimePaths", () => {
  it("creates missing runtime directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-runtime-"));
    temporaryDirectories.push(root);

    await expect(
      verifyRuntimePaths({
        attachmentDir: path.join(root, "attachments"),
        logDir: path.join(root, "logs")
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a path that cannot be created as a directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-runtime-"));
    temporaryDirectories.push(root);
    const blocked = path.join(root, "not-a-directory");
    await writeFile(blocked, "file", "utf8");

    await expect(
      verifyRuntimePaths({
        attachmentDir: path.join(blocked, "attachments"),
        logDir: path.join(root, "logs")
      })
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG"
    });
  });
});
