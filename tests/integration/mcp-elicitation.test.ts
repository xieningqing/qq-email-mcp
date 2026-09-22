import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { MailService } from "../../src/mail/mail-service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  FakeAudit,
  FakeImap,
  FakeSmtp,
  fetchedMessage,
  testConfig
} from "../helpers/fakes.js";

describe("MCP send confirmation", () => {
  it("returns schema-validated status and folder lists", async () => {
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap: new FakeImap(),
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "status-output-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const status = await client.callTool({
        name: "mail_status",
        arguments: {}
      });
      const folders = await client.callTool({
        name: "mail_folders",
        arguments: {}
      });

      expect(status.structuredContent).toMatchObject({
        account: "me@qq.com",
        connected: true,
        ready: true,
        imap: "ok",
        smtp: "ok",
        folders: "ok",
        capabilities: expect.arrayContaining(["IMAP4rev1"]),
        permissions: {
          read: true
        }
      });
      expect(folders.structuredContent).toMatchObject({
        folders: expect.arrayContaining([
          {
            name: "INBOX",
            display_name: "INBOX",
            role: "inbox",
            selectable: true,
            special_use: "\\Inbox"
          }
        ])
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-validated message summaries from mail_list", async () => {
    const imap = new FakeImap();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "output-schema-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "mail_list",
        arguments: {
          limit: 1
        }
      });

      expect(result.structuredContent).toMatchObject({
        messages: [
          {
            message_ref: expect.any(String),
            subject: "Hello",
            has_attachments: false,
            attachment_count: 0,
            snippet: expect.any(String)
          }
        ],
        next_cursor: null
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-validated attachment metadata", async () => {
    const imap = new FakeImap();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        Buffer.from(
          [
            "From: sender@example.com",
            "To: me@qq.com",
            "Subject: Attachment",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="boundary"',
            "",
            "--boundary",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Body",
            "--boundary",
            'Content-Type: text/plain; name="note.txt"',
            'Content-Disposition: attachment; filename="note.txt"',
            "",
            "attachment body",
            "--boundary--",
            ""
          ].join("\r\n")
        )
      )
    );
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "attachment-output-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.callTool({
        name: "mail_list",
        arguments: { limit: 1 }
      });
      const messageRef = (
        listed.structuredContent?.messages as Array<{ message_ref: string }>
      )[0]?.message_ref;
      const read = await client.callTool({
        name: "mail_get",
        arguments: {
          message_ref: messageRef,
          mode: "metadata"
        }
      });
      const attachmentId = (
        read.structuredContent?.attachments as Array<{ attachment_id: string }>
      )[0]?.attachment_id;
      const result = await client.callTool({
        name: "mail_attachment",
        arguments: {
          message_ref: messageRef,
          attachment_id: attachmentId,
          action: "metadata"
        }
      });

      expect(result.structuredContent).toMatchObject({
        attachment_id: attachmentId,
        filename: "note.txt",
        content_type: "text/plain",
        size: expect.any(Number),
        download_path: null,
        extracted_text: null,
        character_count: null,
        truncated: false,
        extractor: null
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-validated results for every mail_get mode", async () => {
    const imap = new FakeImap();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "get-output-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.callTool({
        name: "mail_list",
        arguments: { limit: 1 }
      });
      const messageRef = (
        listed.structuredContent?.messages as Array<{ message_ref: string }>
      )[0]?.message_ref;

      for (const mode of ["metadata", "text", "thread", "agent"] as const) {
        const result = await client.callTool({
          name: "mail_get",
          arguments: {
            message_ref: messageRef,
            mode
          }
        });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toBeTruthy();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns thread_ref in text mode", async () => {
    const imap = new FakeImap();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "text-thread-ref-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.callTool({
        name: "mail_list",
        arguments: { limit: 1 }
      });
      const messageRef = (
        listed.structuredContent?.messages as Array<{ message_ref: string }>
      )[0]?.message_ref;
      const result = await client.callTool({
        name: "mail_get",
        arguments: {
          message_ref: messageRef,
          mode: "text"
        }
      });

      expect(result.structuredContent).toMatchObject({
        message_ref: messageRef,
        thread_ref: "message-1@example.com"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-validated bulk update results", async () => {
    const imap = new FakeImap();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const mail = new MailService({
      config: testConfig({ read: true, update: true }),
      imap,
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "update-output-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.callTool({
        name: "mail_list",
        arguments: { limit: 1 }
      });
      const messageRef = (
        listed.structuredContent?.messages as Array<{ message_ref: string }>
      )[0]?.message_ref;
      const result = await client.callTool({
        name: "mail_update",
        arguments: {
          message_refs: [messageRef, "invalid-ref"],
          action: "mark_read"
        }
      });

      expect(result.structuredContent).toMatchObject({
        updated: 1,
        action: "mark_read",
        failed: [
          {
            message_ref: "invalid-ref",
            code: "INVALID_INPUT",
            retryable: false,
            message: expect.any(String)
          }
        ]
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a stable structured error for invalid message references", async () => {
    const mail = new MailService({
      config: testConfig({ read: true }),
      imap: new FakeImap(),
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "tool-error-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "mail_get",
        arguments: {
          message_ref: "not-a-message-ref",
          mode: "agent"
        }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "INVALID_INPUT",
          message: expect.any(String),
          retryable: false
        }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends after the client accepts the elicitation", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const mail = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "elicitation-test", version: "0.1.0" },
      {
        capabilities: {
          elicitation: {}
        }
      }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: {
        confirm: true
      }
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "mail_send",
        arguments: {
          mode: "new",
          to: ["recipient@example.com"],
          subject: "Hello",
          text: "Body"
        }
      });

      expect(result.structuredContent).toMatchObject({
        status: "sent",
        message_id: expect.any(String),
        accepted: ["recipient@example.com"]
      });
      expect(smtp.sent).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-validated send previews when elicitation is unavailable", async () => {
    const mail = new MailService({
      config: testConfig({ read: true, send: true }),
      imap: new FakeImap(),
      smtp: new FakeSmtp(),
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "send-preview-output-test", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "mail_send",
        arguments: {
          mode: "new",
          to: ["recipient@example.com"],
          subject: "Hello",
          text: "Body"
        }
      });

      expect(result.structuredContent).toMatchObject({
        status: "confirmation_required",
        confirmation_token: expect.any(String),
        preview: {
          to: ["recipient@example.com"],
          subject: "Hello",
          text: "Body",
          attachment_total_bytes: 0,
          attachments: []
        }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("includes body and attachment summary in the elicitation request", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const mail = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "elicitation-content-test", version: "0.1.0" },
      { capabilities: { elicitation: {} } }
    );
    let requestedMessage = "";
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requestedMessage = request.params.message;
      return {
        action: "accept",
        content: { confirm: true }
      };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "mail_send",
        arguments: {
          mode: "new",
          to: ["recipient@example.com"],
          subject: "Hello",
          text: "Please review the attached report.",
          attachments: [
            {
              filename: "report.txt",
              content_type: "text/plain",
              content_base64: Buffer.from("report").toString("base64")
            }
          ]
        }
      });

      expect(requestedMessage).toContain("Please review the attached report.");
      expect(requestedMessage).toContain("report.txt (6 bytes)");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("revokes the confirmation token when the client declines", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const mail = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    let capturedToken: string | undefined;
    const originalSend = mail.send.bind(mail);
    vi.spyOn(mail, "send").mockImplementation(async (input) => {
      const result = await originalSend(input);
      if (typeof result.confirmationToken === "string") {
        capturedToken = result.confirmationToken;
      }
      return result;
    });
    const server = createMcpServer(mail);
    const client = new Client(
      { name: "elicitation-decline-test", version: "0.1.0" },
      {
        capabilities: {
          elicitation: {}
        }
      }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "decline"
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "mail_send",
        arguments: {
          mode: "new",
          to: ["recipient@example.com"],
          subject: "Hello",
          text: "Body"
        }
      });

      expect(result.structuredContent).toMatchObject({
        status: "cancelled"
      });
      expect(smtp.sent).toHaveLength(0);
      expect(capturedToken).toBeTruthy();
      await expect(
        mail.send({
          confirmationToken: capturedToken as string
        })
      ).rejects.toMatchObject({
        code: "CONFIRMATION_INVALID"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
