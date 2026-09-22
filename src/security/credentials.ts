import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "../errors.js";

interface DpapiBindings {
  protectData(
    data: Uint8Array,
    entropy: Uint8Array | null,
    scope: "CurrentUser" | "LocalMachine"
  ): Uint8Array;
  unprotectData(
    data: Uint8Array,
    entropy: Uint8Array | null,
    scope: "CurrentUser" | "LocalMachine"
  ): Uint8Array;
}

interface DpapiModule {
  Dpapi: DpapiBindings;
  isPlatformSupported: boolean;
}

let dpapiModule: DpapiModule | null = null;
let dpapiLoadAttempted = false;

function loadDpapi(): DpapiModule | null {
  if (dpapiLoadAttempted) {
    return dpapiModule;
  }
  dpapiLoadAttempted = true;
  if (process.platform !== "win32") {
    return null;
  }

  try {
    // Loaded lazily so non-Windows installs do not require the native addon.
    const loaded = createRequire(import.meta.url)("@primno/dpapi") as DpapiModule;
    dpapiModule = loaded.isPlatformSupported ? loaded : null;
  } catch {
    dpapiModule = null;
  }
  return dpapiModule;
}

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
        protection?: string;
      };
      if (
        raw.service !== service ||
        raw.account !== account ||
        typeof raw.secret !== "string"
      ) {
        return null;
      }

      if (raw.protection === "dpapi") {
        return this.decryptDpapi(raw.secret);
      }

      // Legacy host-derived encryption. Still readable so existing installs
      // keep working; the next `set()` rewrites it with DPAPI.
      return this.decryptPortable(raw.secret);
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
    const encrypted = this.encrypt(secret);
    await writeFile(
      temporaryFile,
      JSON.stringify(
        {
          service,
          account,
          secret: encrypted.value,
          protection: encrypted.protection
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

  private encrypt(value: string): { value: string; protection: string } {
    const dpapi = loadDpapi();
    if (dpapi) {
      const encrypted = dpapi.Dpapi.protectData(
        Buffer.from(value, "utf8"),
        this.entropy(),
        "CurrentUser"
      );
      return {
        value: Buffer.from(encrypted).toString("base64"),
        protection: "dpapi"
      };
    }

    return { value: this.encryptPortable(value), protection: "host-derived" };
  }

  private decryptDpapi(value: string): string {
    const dpapi = loadDpapi();
    if (!dpapi) {
      throw new AppError(
        "AUTH_FAILED",
        "This credential was encrypted with Windows DPAPI and can only be read on the same Windows user account"
      );
    }
    const decrypted = dpapi.Dpapi.unprotectData(
      Buffer.from(value, "base64"),
      this.entropy(),
      "CurrentUser"
    );
    return Buffer.from(decrypted).toString("utf8");
  }

  private entropy(): Buffer {
    return Buffer.from("qq-email-mcp", "utf8");
  }

  private encryptPortable(value: string): string {
    const key = this.localKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  private decryptPortable(value: string): string {
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
      `No authorization code found for ${account}. Run "npx -y qq-email-mcp init" to configure it, or set QQ_EMAIL_AUTH_CODE.`,
      { details: { service, account } }
    );
  }

  return credential;
}
