import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const enabled = process.env.QQ_EMAIL_MCP_E2E === "1";
const configPath =
  process.env.QQ_EMAIL_MCP_CONFIG ??
  path.join(projectRoot, "qq-email-mcp.toml");

describe.skipIf(!enabled)("real QQ Mail read-only smoke", () => {
  it("connects, lists folders, reads one message and normalizes it", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, "dist", "index.js")],
      cwd: projectRoot,
      env: {
        QQ_EMAIL_MCP_CONFIG: configPath,
        QQ_EMAIL_AUTH_CODE: process.env.QQ_EMAIL_AUTH_CODE
      },
      stderr: "pipe"
    });
    const client = new Client(
      { name: "qq-email-mcp-real-e2e", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      const status = await client.callTool({
        name: "mail_status",
        arguments: {}
      });
      const folders = await client.callTool({
        name: "mail_folders",
        arguments: {}
      });
      const list = await client.callTool({
        name: "mail_list",
        arguments: { folder: "INBOX", limit: 1 }
      });

      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        connected: true,
        ready: true,
        imap: "ok",
        smtp: "ok"
      });
      expect(
        (folders.structuredContent?.folders as unknown[] | undefined)?.length
      ).toBeGreaterThan(0);

      const firstMessage = (
        list.structuredContent?.messages as
          | Array<{ message_ref?: string }>
          | undefined
      )?.[0];
      if (!firstMessage?.message_ref) {
        return;
      }

      const context = await client.callTool({
        name: "mail_get",
        arguments: {
          message_ref: firstMessage.message_ref,
          mode: "agent"
        }
      });

      expect(context.isError).not.toBe(true);
      expect(context.structuredContent).toMatchObject({
        message_ref: firstMessage.message_ref,
        is_untrusted: true
      });

      const search = await client.callTool({
        name: "mail_search",
        arguments: {
          folder: "INBOX",
          limit: 1
        }
      });
      expect(search.isError).not.toBe(true);
      expect(search.structuredContent).toMatchObject({
        messages: expect.any(Array),
        search: {
          executed_server_side: true
        }
      });

      const thread = await client.callTool({
        name: "mail_get",
        arguments: {
          message_ref: firstMessage.message_ref,
          mode: "thread",
          max_chars: 2_000
        }
      });
      expect(thread.isError).not.toBe(true);
      expect(thread.structuredContent).toMatchObject({
        thread_ref: expect.anything(),
        messages: expect.any(Array),
        is_untrusted: true
      });

      const attachmentIds = (
        context.structuredContent?.attachments as
          | Array<{ attachment_id?: string }>
          | undefined
      )
        ?.map((attachment) => attachment.attachment_id)
        .filter((id): id is string => Boolean(id)) ?? [];
      if (attachmentIds[0]) {
        const attachment = await client.callTool({
          name: "mail_attachment",
          arguments: {
            message_ref: firstMessage.message_ref,
            attachment_id: attachmentIds[0],
            action: "metadata"
          }
        });
        expect(attachment.isError).not.toBe(true);
        expect(attachment.structuredContent).toMatchObject({
          attachment_id: attachmentIds[0],
          filename: expect.any(String),
          size: expect.any(Number)
        });
      }
    } finally {
      await client.close();
    }
  }, 60_000);
});
