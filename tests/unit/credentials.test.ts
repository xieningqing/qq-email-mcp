import { mkdtemp, rm } from "node:fs/promises";
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
});
