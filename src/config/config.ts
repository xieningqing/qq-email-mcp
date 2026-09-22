import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { AppError } from "../errors.js";

const configSchema = z.object({
  account: z.object({
    email: z.string().email()
  }),
  permissions: z
    .object({
      read: z.boolean().default(true),
      draft: z.boolean().default(false),
      update: z.boolean().default(false),
      send: z.boolean().default(false)
    })
    .default({ read: true, draft: false, update: false, send: false }),
  imap: z
    .object({
      host: z.string().min(1).default("imap.qq.com"),
      port: z.number().int().positive().default(993),
      secure: z.boolean().default(true)
    })
    .default({ host: "imap.qq.com", port: 993, secure: true }),
  smtp: z
    .object({
      host: z.string().min(1).default("smtp.qq.com"),
      port: z.number().int().positive().default(465),
      secure: z.boolean().default(true)
    })
    .default({ host: "smtp.qq.com", port: 465, secure: true }),
  security: z
    .object({
      credential_target: z.string().min(1).default("qq-email-mcp"),
      attachment_dir: z.string().min(1).default("./downloads"),
      max_attachment_bytes: z.number().int().positive().default(25 * 1024 * 1024),
      max_total_attachment_bytes: z
        .number()
        .int()
        .positive()
        .default(50 * 1024 * 1024),
      allow_remote_images: z.boolean().default(false)
    })
    .default({
      credential_target: "qq-email-mcp",
      attachment_dir: "./downloads",
      max_attachment_bytes: 25 * 1024 * 1024,
      max_total_attachment_bytes: 50 * 1024 * 1024,
      allow_remote_images: false
    }),
  send: z
    .object({
      save_sent: z.enum(["never", "always"]).default("never")
    })
    .default({ save_sent: "never" })
});

export interface AppConfig {
  account: {
    email: string;
  };
  permissions: {
    read: boolean;
    draft: boolean;
    update: boolean;
    send: boolean;
  };
  imap: {
    host: string;
    port: number;
    secure: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
  security: {
    credentialTarget: string;
    attachmentDir: string;
    maxAttachmentBytes: number;
    maxTotalAttachmentBytes: number;
    allowRemoteImages: boolean;
  };
  send: {
    saveSent: "never" | "always";
  };
  configPath: string | null;
}

export interface ConfigLoadOptions {
  configPath?: string;
  cwd?: string;
}

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<AppConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath =
    options.configPath ??
    process.env.QQ_EMAIL_MCP_CONFIG ??
    path.resolve(cwd, "qq-email-mcp.toml");
  const resolvedConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(resolvedConfigPath);

  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AppError("CONFIG_MISSING", `Configuration file not found: ${resolvedConfigPath}`, {
        details: { configPath: resolvedConfigPath },
        cause: error
      });
    }

    throw new AppError("INVALID_CONFIG", `Unable to read configuration: ${resolvedConfigPath}`, {
      details: { configPath: resolvedConfigPath },
      cause: error
    });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("INVALID_CONFIG", "Invalid configuration", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  if (
    parsed.data.security.max_total_attachment_bytes <
    parsed.data.security.max_attachment_bytes
  ) {
    throw new AppError(
      "INVALID_CONFIG",
      "security.max_total_attachment_bytes must be greater than or equal to security.max_attachment_bytes"
    );
  }

  if (
    (parsed.data.permissions.draft ||
      parsed.data.permissions.update ||
      parsed.data.permissions.send) &&
    !parsed.data.permissions.read
  ) {
    throw new AppError(
      "INVALID_CONFIG",
      "permissions.read must be enabled when permissions.draft, permissions.update or permissions.send is enabled"
    );
  }

  return {
    account: parsed.data.account,
    permissions: parsed.data.permissions,
    imap: parsed.data.imap,
    smtp: parsed.data.smtp,
    security: {
      credentialTarget: parsed.data.security.credential_target,
      attachmentDir: path.resolve(
        configDirectory,
        parsed.data.security.attachment_dir
      ),
      maxAttachmentBytes: parsed.data.security.max_attachment_bytes,
      maxTotalAttachmentBytes: parsed.data.security.max_total_attachment_bytes,
      allowRemoteImages: parsed.data.security.allow_remote_images
    },
    send: {
      saveSent: parsed.data.send.save_sent
    },
    configPath: resolvedConfigPath
  };
}

export function tryLoadConfig(options: ConfigLoadOptions = {}): Promise<AppConfig> {
  return loadConfig(options);
}
