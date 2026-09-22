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
  const usesDefaultCredentials = options.credentialsPath === undefined;
  if (usesDefaultCredentials && !process.stdin.isTTY && !options.credentialStore) {
    // Non-interactive runs (scripts, CI, an agent's smoke test) must opt in
    // explicitly before overwriting the real global credential file.
    throw new Error(
      "Refusing to write the default credential file in a non-interactive run. " +
        "Pass --credentials <path> to target a specific file."
    );
  }
  const credentialsPath = path.resolve(
    options.credentialsPath ?? defaultCredentialsPath()
  );
  const prompts = new PromptReader();
  const account = options.account ?? (await prompts.text("QQ Mail address: "));
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

  const secret = options.secret ?? (await prompts.hidden("QQ Mail authorization code: "));
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
          // The package name is the only stable reference: under npx the
          // install lives in a throwaway cache directory.
          command: "npx",
          args: ["-y", "qq-email-mcp"]
        }
      }
    }
  };
}

/**
 * Reads answers one at a time. Piped stdin (the common npx case) is buffered
 * once and split by line, because consuming the stream twice would abort the
 * second prompt.
 */
class PromptReader {
  private pipedLines: string[] | null = null;
  private lineBuffer = "";

  async text(message: string): Promise<string> {
    process.stderr.write(message);
    if (!process.stdin.isTTY) {
      this.pipedLines ??= await readAllStdin();
      return (this.pipedLines.shift() ?? "").trim();
    }
    return this.readLineFromEvents(false);
  }

  async hidden(message: string): Promise<string> {
    const input = process.stdin;
    const output = process.stderr;
    if (!input.isTTY) {
      output.write(message);
      this.pipedLines ??= await readAllStdin();
      return (this.pipedLines.shift() ?? "").trim();
    }

    output.write(message);
    return this.readLineFromEvents(true);
  }

  /**
   * Reads a single line using event listeners. Using `for await` would destroy
   * the shared stdin stream on the first `return`, so a second prompt would
   * fail with "The operation was aborted".
   */
  private readLineFromEvents(mask: boolean): Promise<string> {
    const input = process.stdin;
    const output = process.stderr;

    return new Promise<string>((resolve, reject) => {
      if (mask) {
        input.setRawMode(true);
      }
      input.resume();
      let value = this.lineBuffer;
      this.lineBuffer = "";

      const cleanup = () => {
        input.off("data", onData);
        input.off("error", onError);
        if (mask) {
          input.setRawMode(false);
        }
        input.pause();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const character of text) {
          if (character === "\r" || character === "\n") {
            if (mask) {
              output.write("\n");
            }
            cleanup();
            resolve(value.trim());
            return;
          }
          if (character === "\u0003") {
            if (mask) {
              output.write("\n");
            }
            cleanup();
            process.exit(130);
          }
          if (mask && (character === "\u007f" || character === "\b")) {
            value = value.slice(0, -1);
            continue;
          }
          value += character;
        }
      };

      input.on("data", onData);
      input.once("error", onError);
    });
  }
}

async function readAllStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}
