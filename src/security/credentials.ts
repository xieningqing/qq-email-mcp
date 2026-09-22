import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "../errors.js";

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
}

export class LocalCredentialStore implements CredentialStore {
  constructor(
    private readonly credentialFile = path.join(
      os.homedir(),
      ".qq-email-mcp",
      "credentials.json"
    )
  ) {}

  async get(service: string, account: string): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(this.credentialFile, "utf8")) as {
        service?: string;
        account?: string;
        secret?: string;
      };
      if (
        raw.service !== service ||
        raw.account !== account ||
        typeof raw.secret !== "string"
      ) {
        return null;
      }

      return this.decrypt(raw.secret);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new AppError("AUTH_FAILED", "Unable to read the QQ Mail authorization code", {
        cause: error
      });
    }
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const directory = path.dirname(this.credentialFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.credentialFile}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(
      temporaryFile,
      JSON.stringify(
        {
          service,
          account,
          secret: this.encrypt(secret)
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 0o600 }
    );
    try {
      await rename(temporaryFile, this.credentialFile);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private encrypt(value: string): string {
    const key = this.localKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  private decrypt(value: string): string {
    const payload = Buffer.from(value, "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.localKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      "utf8"
    );
  }

  private localKey(): Buffer {
    return createHash("sha256")
      .update(`${os.hostname()}\0${os.userInfo().username}`)
      .digest();
  }
}

export class EnvironmentCredentialStore implements CredentialStore {
  async get(_service: string, _account: string): Promise<string | null> {
    return process.env.QQ_EMAIL_AUTH_CODE ?? null;
  }
}

export class FallbackCredentialStore implements CredentialStore {
  constructor(
    private readonly primary: CredentialStore,
    private readonly fallback: CredentialStore
  ) {}

  async get(service: string, account: string): Promise<string | null> {
    let primaryError: unknown;
    try {
      const primaryValue = await this.primary.get(service, account);
      if (primaryValue) {
        return primaryValue;
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      const fallbackValue = await this.fallback.get(service, account);
      if (fallbackValue) {
        return fallbackValue;
      }
    } catch (fallbackError) {
      if (primaryError) {
        throw primaryError;
      }
      throw fallbackError;
    }

    if (primaryError) {
      throw primaryError;
    }

    return null;
  }
}

export async function requireCredential(
  store: CredentialStore,
  service: string,
  account: string
): Promise<string> {
  const credential = await store.get(service, account);
  if (!credential) {
    throw new AppError(
      "CONFIG_MISSING",
      `No authorization code found for ${account}. Run "npm run set-password -- qq-email-mcp ${account} YOUR_AUTH_CODE" or set QQ_EMAIL_AUTH_CODE.`,
      { details: { service, account } }
    );
  }

  return credential;
}
