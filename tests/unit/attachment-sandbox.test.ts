import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentSandbox,
  sanitizeFilename
} from "../../src/security/attachment-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("attachment sandbox", () => {
  it("strips path traversal from filenames", () => {
    expect(sanitizeFilename("../../evil.exe")).toBe("evil.exe");
    expect(sanitizeFilename("C:\\temp\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..")).toBe("attachment.bin");
  });

  it("writes only inside the sandbox with a unique prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-sandbox-"));
    temporaryDirectories.push(root);
    const sandbox = new AttachmentSandbox(root);

    const target = await sandbox.save(Buffer.from("hello"), "../report.txt");
    const resolvedRoot = await realpath(root);
    const files = await readdir(resolvedRoot);
    const relative = path.relative(resolvedRoot, target);

    expect(relative).not.toBe("");
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]+-report\.txt$/);
  });

  it("restricts saved attachments to the current user", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-sandbox-"));
    temporaryDirectories.push(root);
    const sandbox = new AttachmentSandbox(root);

    const target = await sandbox.save(Buffer.from("secret"), "secret.txt");
    const fileStat = await stat(target);

    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});
