import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";

const MAX_SAFE_FILENAME_LENGTH = 180;

export function sanitizeFilename(input: string | undefined, fallback = "attachment.bin"): string {
  const basename = path.basename(input?.replaceAll("\\", "/") ?? "");
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, MAX_SAFE_FILENAME_LENGTH);

  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return fallback;
  }

  return cleaned;
}

export class AttachmentSandbox {
  constructor(private readonly rootDir: string) {}

  async save(content: Buffer, filename: string | undefined): Promise<string> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });

    const root = await realpath(this.rootDir);
    const safeName = sanitizeFilename(filename);
    const uniqueName = `${randomUUID()}-${safeName}`;
    const target = path.resolve(root, uniqueName);
    const relative = path.relative(root, target);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AppError("INVALID_ATTACHMENT_PATH", "Attachment path escaped the sandbox");
    }

    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    const targetStat = await stat(target);
    return targetStat.isFile() ? target : root;
  }
}
