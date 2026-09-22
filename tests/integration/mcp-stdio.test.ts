import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");

describe("MCP stdio transport", () => {
  it("initializes and lists the nine email tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, "dist", "index.js")],
      cwd: projectRoot,
      env: {
        QQ_EMAIL_MCP_CONFIG: path.join(projectRoot, "qq-email-mcp.example.toml"),
        QQ_EMAIL_AUTH_CODE: "test-auth-code"
      },
      stderr: "pipe"
    });
    const client = new Client(
      { name: "qq-email-mcp-test", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name).sort();

      expect(names).toEqual([
        "mail_attachment",
        "mail_digest",
        "mail_folders",
        "mail_get",
        "mail_list",
        "mail_search",
        "mail_send",
        "mail_status",
        "mail_update"
      ]);
    } finally {
      await client.close();
    }
  });
});
