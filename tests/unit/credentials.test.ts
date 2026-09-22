import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FallbackCredentialStore,
  LocalCredentialStore,
  type CredentialStore
} from "../../src/security/credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("FallbackCredentialStore", () => {
  it("uses the fallback when the primary has no value", async () => {
    const primary: CredentialStore = {
      async get() {
        return null;
      }
    };
    const fallback: CredentialStore = {
      async get() {
        return "fallback-code";
      }
    };

    const store = new FallbackCredentialStore(primary, fallback);
    await expect(store.get("service", "account")).resolves.toBe("fallback-code");
  });

  it("uses the fallback when the primary credential read fails", async () => {
    const primary: CredentialStore = {
      async get() {
        throw new Error("credential file unavailable");
      }
    };
    const fallback: CredentialStore = {
      async get() {
        return "environment-code";
      }
    };

    const store = new FallbackCredentialStore(primary, fallback);
    await expect(store.get("service", "account")).resolves.toBe("environment-code");
  });

  it("preserves the primary error when both stores fail", async () => {
    const primary: CredentialStore = {
      async get() {
        throw new Error("credential file unavailable");
      }
    };
    const fallback: CredentialStore = {
      async get() {
        throw new Error("environment unavailable");
      }
    };

    const store = new FallbackCredentialStore(primary, fallback);
    await expect(store.get("service", "account")).rejects.toThrow(
      "credential file unavailable"
    );
  });
});

describe("LocalCredentialStore", () => {
  it("stores and decrypts a credential for the matching account", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-credentials-"));
    temporaryDirectories.push(root);
    const store = new LocalCredentialStore(path.join(root, "credentials.json"));

    await store.set("qq-email-mcp", "me@qq.com", "auth-code");
    await expect(store.get("qq-email-mcp", "me@qq.com")).resolves.toBe("auth-code");
    await expect(store.get("qq-email-mcp", "other@qq.com")).resolves.toBeNull();

    await store.set("qq-email-mcp", "me@qq.com", "new-auth-code");
    await expect(store.get("qq-email-mcp", "me@qq.com")).resolves.toBe("new-auth-code");
  });

  it("uses OS-backed protection on Windows and marks the format", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-credentials-"));
    temporaryDirectories.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const store = new LocalCredentialStore(credentialFile);

    await store.set("qq-email-mcp", "me@qq.com", "secret-code");

    const raw = JSON.parse(await readFile(credentialFile, "utf8")) as {
      secret: string;
      protection?: string;
    };
    expect(raw.secret).not.toContain("secret-code");
    if (process.platform === "win32") {
      expect(raw.protection).toBe("dpapi");
    }
  });

  it("still reads legacy host-derived credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qq-mail-credentials-"));
    temporaryDirectories.push(root);
    const credentialFile = path.join(root, "credentials.json");

    // Reproduce the pre-DPAPI format: no protection field, host-derived AES key.
    const key = createHash("sha256")
      .update(`${os.hostname()}\0${os.userInfo().username}`)
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update("legacy-code", "utf8"),
      cipher.final()
    ]);
    const legacySecret = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64"
    );

    await writeFile(
      credentialFile,
      JSON.stringify({
        service: "qq-email-mcp",
        account: "me@qq.com",
        secret: legacySecret
      }),
      "utf8"
    );

    const store = new LocalCredentialStore(credentialFile);
    await expect(store.get("qq-email-mcp", "me@qq.com")).resolves.toBe("legacy-code");
  });
});
