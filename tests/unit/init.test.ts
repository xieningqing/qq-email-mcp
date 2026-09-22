import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialize } from "../../src/init.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("initialize", () => {
  it("writes a config template with the provided account", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "qq-mail-init-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.toml");
    const credentialsPath = path.join(directory, "credentials.json");

    const result = await initialize({
      configPath,
      credentialsPath,
      account: "me@qq.com",
      secret: "test-auth-code",
      credentialStore: {
        async get() {
          return "test-auth-code";
        },
        async set() {}
      }
    });
    const content = await readFile(configPath, "utf8");

    expect(result.configPath).toBe(path.resolve(configPath));
    expect(content).toContain('email = "me@qq.com"');
    expect(content).toContain("[permissions]");
    expect(content).toContain("draft = false");
  });
});
