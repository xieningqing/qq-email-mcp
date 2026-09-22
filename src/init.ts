import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LocalCredentialStore, type CredentialStore } from "./security/credentials.js";

interface WritableCredentialStore extends CredentialStore {
  set(service: string, account: string, secret: string): Promise<void>;
}

const DEFAULT_CONFIG = `[account]
email = "your-account@qq.com"

[permissions]
read = true
draft = false
update = false
send = false

[imap]
host = "imap.qq.com"
port = 993
secure = true

[smtp]
host = "smtp.qq.com"
port = 465
secure = true

[security]
credential_target = "qq-email-mcp"
attachment_dir = "./downloads"
max_attachment_bytes = 26214400
max_total_attachment_bytes = 52428800
allow_remote_images = false

[send]
save_sent = "never"
`;

export interface InitOptions {
  configPath?: string | undefined;
  credentialsPath?: string | undefined;
  account?: string | undefined;
  secret?: string | undefined;
  credentialStore?: WritableCredentialStore | undefined;
}

export interface InitResult {
  configPath: string;
  credentialsPath: string;
  clientConfig: unknown;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".qq-email-mcp", "config.toml");
}

export function defaultCredentialsPath(): string {
  return (
    process.env.QQ_EMAIL_MCP_CREDENTIALS ??
    path.join(os.homedir(), ".qq-email-mcp", "credentials.json")
  );
}

export async function initialize(options: InitOptions = {}): Promise<InitResult> {
  const configPath = path.resolve(options.configPath ?? defaultConfigPath());
  const credentialsPath = path.resolve(
    options.credentialsPath ?? defaultCredentialsPath()
  );
  const account = options.account ?? (await promptText("QQ Mail address: "));
  if (!account) {
    throw new Error("Account email is required");
  }

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await readFile(configPath, "utf8");
  } catch {
    await writeFile(configPath, DEFAULT_CONFIG.replace("your-account@qq.com", account), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  const secret = options.secret ?? (await promptHidden("QQ Mail authorization code: "));
  if (!secret) {
    throw new Error("Authorization code is required");
  }

  const store = options.credentialStore ?? new LocalCredentialStore(credentialsPath);

  try {
    await copyFile(credentialsPath, `${credentialsPath}.bak`);
    process.stderr.write(`Existing credentials backed up to ${credentialsPath}.bak\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await store.set("qq-email-mcp", account, secret);

  return {
    configPath,
    credentialsPath,
    clientConfig: {
      mcpServers: {
        "qq-email-mcp": {
          command: process.execPath,
          args: [
            path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js")
          ]
        }
      }
    }
  };
}

async function promptText(message: string): Promise<string> {
  process.stderr.write(message);
  for await (const chunk of process.stdin) {
    return chunk.toString("utf8").split(/\r?\n/, 1)[0]!.trim();
  }
  return "";
}

async function promptHidden(message: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY) {
    return promptText(message);
  }

  output.write(message);
  input.setRawMode(true);
  input.resume();
  let value = "";
  try {
    for await (const chunk of input) {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          output.write("\n");
          return value.trim();
        }
        if (character === "\u0003") {
          output.write("\n");
          process.exit(130);
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }
  } finally {
    input.setRawMode(false);
    input.pause();
  }
  return value.trim();
}
