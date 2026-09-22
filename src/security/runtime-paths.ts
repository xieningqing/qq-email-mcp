import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";

async function verifyWritableDirectory(directory: string, label: string): Promise<void> {
  const probe = path.join(directory, `.qq-email-mcp-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "probe", { flag: "wx" });
  } catch (error) {
    throw new AppError(
      "INVALID_CONFIG",
      `${label} is not writable: ${directory}`,
      {
        details: { directory },
        cause: error
      }
    );
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

export async function verifyRuntimePaths(options: {
  attachmentDir: string;
  logDir: string;
}): Promise<void> {
  await verifyWritableDirectory(options.attachmentDir, "Attachment directory");
  await verifyWritableDirectory(options.logDir, "Log directory");
}
