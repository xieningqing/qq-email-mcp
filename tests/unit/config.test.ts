import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigCandidates } from "../../src/config/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeConfig(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qq-mail-config-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "qq-email-mcp.toml");
  await writeFile(configPath, content, "utf8");
  return configPath;
}

describe("loadConfig", () => {
  it("rejects a total attachment limit below the per-attachment limit", async () => {
    const configPath = await writeConfig(`
[account]
email = "me@qq.com"

[security]
max_attachment_bytes = 100
max_total_attachment_bytes = 50
`);

    await expect(loadConfig({ configPath })).rejects.toMatchObject({
      code: "INVALID_CONFIG"
    });
  });

  it("rejects write permissions without read permission", async () => {
    const configPath = await writeConfig(`
[account]
email = "me@qq.com"

[permissions]
read = false
update = true
send = true
`);

    await expect(loadConfig({ configPath })).rejects.toMatchObject({
      code: "INVALID_CONFIG"
    });
  });

  it("resolves relative attachment paths from the configuration directory", async () => {
    const configPath = await writeConfig(`
[account]
email = "me@qq.com"

[security]
attachment_dir = "./mail-downloads"
`);

    const config = await loadConfig({
      configPath,
      cwd: path.join(path.dirname(configPath), "unrelated-cwd")
    });

    expect(config.configPath).toBe(path.resolve(configPath));
    expect(config.security.attachmentDir).toBe(
      path.join(path.dirname(configPath), "mail-downloads")
    );
  });

  it("finds the packaged config without env or cwd hints", async () => {
    const originalConfig = process.env.QQ_EMAIL_MCP_CONFIG;
    delete process.env.QQ_EMAIL_MCP_CONFIG;
    try {
      const candidates = resolveConfigCandidates({
        cwd: path.join(os.tmpdir(), "definitely-unrelated-cwd")
      });

      // The package-root config must be a fallback candidate even without env.
      expect(candidates.some((candidate) => candidate.endsWith("qq-email-mcp.toml"))).toBe(
        true
      );
      expect(candidates.some((candidate) => candidate.includes(".qq-email-mcp"))).toBe(
        true
      );
    } finally {
      if (originalConfig === undefined) {
        delete process.env.QQ_EMAIL_MCP_CONFIG;
      } else {
        process.env.QQ_EMAIL_MCP_CONFIG = originalConfig;
      }
    }
  });
});
