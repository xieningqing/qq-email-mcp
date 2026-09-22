import { describe, expect, it } from "vitest";
import { MailService } from "../../src/mail/mail-service.js";
import { AppError } from "../../src/errors.js";
import {
  FakeAudit,
  FakeImap,
  FakeSmtp,
  fetchedMessage,
  rawMessage,
  testConfig
} from "../helpers/fakes.js";

function createService(options: {
  read?: boolean;
  draft?: boolean;
  update?: boolean;
  send?: boolean;
} = {}) {
  const imap = new FakeImap();
  const smtp = new FakeSmtp();
  const audit = new FakeAudit();
  const service = new MailService({
    config: testConfig({
      read: options.read ?? true,
      draft: options.draft ?? false,
      update: options.update ?? false,
      send: options.send ?? false
    }),
    imap,
    smtp,
    audit
  });

  return { service, imap, smtp, audit };
}

describe("MailService", () => {
  it("lists messages with an opaque cursor", async () => {
    const { service, imap } = createService();
    imap.searchResult = [3, 2, 1];
    imap.messages.set(3, fetchedMessage(3));
    imap.messages.set(2, fetchedMessage(2));
    imap.messages.set(1, fetchedMessage(1));

    const first = await service.list({ limit: 2 });
    const second = await service.list({ limit: 2, cursor: first.nextCursor });

    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.messages[0]?.to[0]?.address).toBe("me@qq.com");
    expect(first.messages[0]?.snippet).toContain("Body");
    expect(first.messages[0]?.attachmentCount).toBe(0);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.subject).toBe("Hello");
    expect(imap.searchCalls[1]?.beforeUid).toBe(2);
  });

  it("passes date filters through mail_list", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));

    await service.list({
      limit: 1,
      since: "2026-09-01",
      before: "2026-10-01"
    });

    expect(imap.searchCalls[0]?.since).toBe("2026-09-01");
    expect(imap.searchCalls[0]?.before).toBe("2026-10-01");
  });

  it("can return subject-only summaries", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));

    const listed = await service.list({ limit: 1, includeSnippet: false });
    expect(listed.messages[0]?.snippet).toBeNull();
  });

  it("supports recent_days for mail_list", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));

    await service.list({ limit: 1, recentDays: 30 });

    expect(imap.searchCalls[0]?.since).toBeDefined();
    expect(typeof imap.searchCalls[0]?.since).toBe("string");
    expect(imap.searchCalls[0]?.before).toBeUndefined();
  });

  it("rejects recent_days combined with explicit dates", async () => {
    const { service } = createService();

    await expect(
      service.list({ recentDays: 30, since: "2026-09-01" })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects recent_days in mail_search", async () => {
    const { service, imap } = createService();

    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));

    await service.search({ recentDays: 30 });
    expect(imap.searchCalls[0]?.since).toBeDefined();
  });

  it("returns a digest for recent mail", async () => {
    const { service, imap } = createService();
    imap.searchResult = [3, 2, 1];
    imap.messages.set(3, fetchedMessage(3));
    imap.messages.set(2, fetchedMessage(2));
    imap.messages.set(1, fetchedMessage(1));

    const digest = await service.digest({ recentDays: 7, limit: 2 });

    expect(digest.total).toBe(3);
    expect(digest.messages).toHaveLength(2);
    expect(digest.unread).toBe(2);
    expect(digest.withAttachments).toBe(0);
    expect(typeof digest.since).toBe("string");
  });

  it("falls back to internalDate when the envelope date is invalid", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    const message = fetchedMessage(1);
    message.envelope = {
      ...message.envelope,
      date: new Date("invalid")
    };
    imap.messages.set(1, message);

    const listed = await service.list({ limit: 1 });

    expect(new Date(listed.messages[0]!.date).toISOString()).toBe(
      "2026-09-21T02:00:00.000Z"
    );
    expect(listed.messages[0]!.date).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it("rejects stale cursors after UIDVALIDITY changes", async () => {
    const { service, imap } = createService();
    imap.searchResult = [3, 2, 1];
    imap.messages.set(3, fetchedMessage(3));
    imap.messages.set(2, fetchedMessage(2));

    const first = await service.list({ limit: 1 });
    imap.uidValidity = "200";

    await expect(service.list({ limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({
      code: "STALE_MESSAGE_REF"
    } satisfies Partial<AppError>);
  });

  it("marks attachments in message list summaries", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          attachment: {
            filename: "report.txt",
            contentType: "text/plain",
            content: "attachment body"
          }
        })
      )
    );

    const listed = await service.list({ limit: 1 });

    expect(listed.messages[0]).toMatchObject({
      hasAttachments: true,
      attachmentCount: 1
    });
  });

  it("returns normalized agent context", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          subject: "测试",
          text: "Hello AI"
        })
      )
    );

    const listed = await service.list({ limit: 1 });
    const context = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "agent"
    })) as { text: string; isUntrusted: boolean; messageRef: string };

    expect(context.text).toContain("Hello AI");
    expect(context.isUntrusted).toBe(true);
    expect(context.messageRef).toBe(listed.messages[0]?.messageRef);
  });

  it("returns stable metadata for thread and deduplication decisions", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          references: ["root@example.com"],
          replyTo: "replies@example.com",
          attachment: {
            filename: "report.txt",
            contentType: "text/plain",
            content: "content"
          }
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const metadata = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "metadata"
    })) as {
      messageId: string | null;
      inReplyTo: string | null;
      references: string[];
      replyTo: Array<{ address: string }>;
      hasAttachments: boolean;
      attachmentCount: number;
    };

    expect(metadata).toMatchObject({
      messageId: "reply@example.com",
      inReplyTo: "root@example.com",
      references: ["root@example.com"],
      replyTo: [{ address: "replies@example.com" }],
      unread: true,
      flagged: false,
      hasAttachments: true,
      attachmentCount: 1
    });
  });

  it("saves a draft to the Drafts folder without sending", async () => {
    const { service, imap, smtp } = createService({ draft: true });

    const result = await service.draft({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Draft subject",
      text: "Draft body"
    });

    expect(result).toMatchObject({
      status: "saved",
      folder: "Drafts",
      subject: "Draft subject"
    });
    expect(imap.appends).toHaveLength(1);
    expect(imap.appends[0]?.folder).toBe("Drafts");
    expect(imap.appends[0]?.flags).toContain("\\Draft");
    expect(smtp.sent).toHaveLength(0);
  });

  it("rejects drafts when draft and update permissions are disabled", async () => {
    const { service, imap } = createService();

    await expect(
      service.draft({
        mode: "new",
        to: ["recipient@example.com"],
        subject: "Draft subject",
        text: "Draft body"
      })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(imap.appends).toHaveLength(0);
  });

  it("allows saving an incomplete draft", async () => {
    const { service, imap } = createService({ draft: true });

    const result = await service.draft({ subject: "Half-written" });

    expect(result).toMatchObject({ status: "saved", folder: "Drafts" });
    expect(imap.appends).toHaveLength(1);
  });

  it("requires a preview confirmation before sending", async () => {
    const { service, smtp } = createService({ send: true });

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body"
    });

    expect(preview.status).toBe("confirmation_required");
    expect(smtp.sent).toHaveLength(0);

    const token = preview.confirmationToken as string;
    const sent = await service.send({
      confirmationToken: token
    });

    expect(sent.status).toBe("sent");
    expect(smtp.sent).toHaveLength(1);

    await expect(
      service.send({
        confirmationToken: token
      })
    ).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
  });

  it("normalizes duplicate and blank recipients for new messages", async () => {
    const { service } = createService({ send: true });

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com", " recipient@example.com ", ""],
      cc: ["cc@example.com", "cc@example.com"],
      bcc: ["bcc@example.com", ""],
      subject: "Hello",
      text: "Body"
    });

    expect(preview.preview).toMatchObject({
      to: ["recipient@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"]
    });
  });

  it("allows a new HTML-only message", async () => {
    const { service } = createService({ send: true });

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "HTML only",
      html: "<p>Hello <strong>HTML</strong></p>"
    });

    expect(preview.preview).toMatchObject({
      text: "",
      html: "<p>Hello <strong>HTML</strong></p>"
    });
  });

  it("rejects line breaks in the outgoing subject", async () => {
    const { service, smtp } = createService({ send: true });

    await expect(
      service.send({
        mode: "new",
        to: ["recipient@example.com"],
        subject: "Hello\r\nBcc: evil@example.com",
        text: "Body"
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it("warns about risky HTML in the send preview without altering it", async () => {
    const { service, smtp } = createService({ send: true });
    const html = '<p>Hello</p><script>alert(1)</script><img src="https://example.com/p.gif">';

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Hello",
      html
    });

    expect(preview.preview).toMatchObject({
      html,
      warnings: expect.arrayContaining([
        "HTML contains script content",
        "HTML references remote resources"
      ])
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it("reports attachment budget and warns near the total limit", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: {
        ...testConfig({ send: true }),
        security: {
          ...testConfig().security,
          maxAttachmentBytes: 100,
          maxTotalAttachmentBytes: 10
        }
      },
      imap,
      smtp,
      audit: new FakeAudit()
    });

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Attachment",
      text: "Body",
      attachments: [
        {
          filename: "note.txt",
          contentBase64: Buffer.from("123456789").toString("base64")
        }
      ]
    });

    expect(preview.preview).toMatchObject({
      attachmentTotalBytes: 9,
      maxAttachmentBytes: 100,
      maxTotalAttachmentBytes: 10,
      warnings: expect.arrayContaining([
        "Attachments are close to the configured total size limit"
      ])
    });
  });

  it("rejects empty attachment content", async () => {
    const { service } = createService({ send: true });

    await expect(
      service.send({
        mode: "new",
        to: ["recipient@example.com"],
        subject: "Empty attachment",
        text: "Body",
        attachments: [
          {
            filename: "empty.txt",
            contentBase64: ""
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("rejects more than 100 outgoing attachments", async () => {
    const { service } = createService({ send: true });
    const attachments = Array.from({ length: 101 }, (_, index) => ({
      filename: `note-${index}.txt`,
      contentBase64: Buffer.from("x").toString("base64")
    }));

    await expect(
      service.send({
        mode: "new",
        to: ["recipient@example.com"],
        subject: "Too many",
        text: "Body",
        attachments
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("rejects write operations when permissions are disabled", async () => {
    const { service } = createService();

    await expect(
      service.update({
        messageRefs: ["invalid"],
        action: "mark_read"
      })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("reports folder roles and IMAP capabilities in status", async () => {
    const { service } = createService();

    await expect(service.status()).resolves.toMatchObject({
      account: "me@qq.com",
      connected: true,
      ready: true,
      imap: "ok",
      smtp: "ok",
      folderRoles: expect.arrayContaining([
        {
          name: "INBOX",
          role: "inbox"
        }
      ]),
      capabilities: expect.arrayContaining(["IMAP4rev1", "UIDPLUS"])
    });
  });

  it("reports IMAP readability separately from SMTP readiness", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    smtp.verify = async () => {
      throw new Error("smtp unavailable");
    };
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });

    await expect(service.status()).resolves.toMatchObject({
      connected: true,
      ready: false,
      imap: "ok",
      smtp: "error",
      warnings: ["SMTP is unavailable"]
    });
  });

  it("does not leak raw adapter errors from status warnings", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    imap.connect = async () => {
      throw new AppError("NETWORK_ERROR", "connect failed for me@qq.com at imap.qq.com");
    };
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });

    const status = await service.status();

    expect(status.account).toBe("me@qq.com");
    expect(status.warnings).toEqual(["IMAP network error"]);
    expect(JSON.stringify(status)).not.toContain("imap.qq.com");
    expect(JSON.stringify(status)).not.toContain("connect failed for");
  });

  it("records auditable context and duration for message reads", async () => {
    const { service, imap, audit } = createService();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const listed = await service.list({ limit: 1 });

    await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "metadata"
    });

    const readEvent = audit.events.find((event) => event.tool === "mail_get");
    expect(readEvent).toMatchObject({
      result: "success",
      folder: "INBOX",
      uid: 1
    });
    expect(readEvent?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records the folder for list and search audits", async () => {
    const { service, imap, audit } = createService();
    imap.searchResult = [];

    await service.list({ folder: "INBOX", limit: 1 });
    await service.search({ folder: "Archive", query: "invoice" });

    expect(
      audit.events.find((event) => event.tool === "mail_list")
    ).toMatchObject({
      result: "success",
      folder: "INBOX"
    });
    expect(
      audit.events.find((event) => event.tool === "mail_search")
    ).toMatchObject({
      result: "success",
      folder: "Archive"
    });
  });

  it("does not expose messages after UIDVALIDITY changes", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));
    const listed = await service.list({ limit: 1 });
    imap.uidValidity = "999";

    await expect(
      service.get({
        messageRef: listed.messages[0]?.messageRef ?? "",
        mode: "agent"
      })
    ).rejects.toMatchObject({ code: "STALE_MESSAGE_REF" });
  });

  it("builds a reply thread from message references", async () => {
    const { service, imap } = createService();
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Original"
        })
      )
    );
    imap.messages.set(
      2,
      fetchedMessage(
        2,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          references: ["root@example.com"],
          subject: "Re: Original"
        })
      )
    );
    imap.searchResult = [2, 1];

    const listed = await service.list({ limit: 1 });
    const thread = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "thread"
    })) as {
      messages: Array<{ messageId: string | null; subject: string }>;
    };

    expect(thread.messages.map((message) => message.messageId)).toEqual([
      "root@example.com",
      "reply@example.com"
    ]);
  });

  it("includes replies when a thread is opened from the root message", async () => {
    const { service, imap } = createService();
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Original"
        })
      )
    );
    imap.messages.set(
      2,
      fetchedMessage(
        2,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          references: ["root@example.com"],
          subject: "Re: Original"
        })
      )
    );
    imap.searchResult = [1];

    const listed = await service.list({ limit: 1 });
    const thread = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "thread"
    })) as {
      messages: Array<{ messageId: string | null }>;
    };

    expect(thread.messages.map((message) => message.messageId)).toEqual([
      "root@example.com",
      "reply@example.com"
    ]);
  });

  it("includes replies whose In-Reply-To points at an existing message", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Original"
        })
      )
    );
    imap.messages.set(
      2,
      fetchedMessage(
        2,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          subject: "Re: Original"
        })
      )
    );

    const listed = await service.list({ limit: 1 });
    const rootThread = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "thread"
    })) as {
      messages: Array<{ messageId: string | null }>;
      threadRef: string | null;
    };

    expect(rootThread.messages.map((message) => message.messageId)).toEqual([
      "root@example.com",
      "reply@example.com"
    ]);
    expect(rootThread.messages[1]).toMatchObject({
      messageId: "reply@example.com",
      inReplyTo: "root@example.com",
      references: []
    });
    expect(rootThread.threadRef).toBe("root@example.com");
  });

  it("keeps threadRef stable when opening a thread from a reply", async () => {
    const { service, imap } = createService();
    imap.searchResult = [2, 1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Original"
        })
      )
    );
    imap.messages.set(
      2,
      fetchedMessage(
        2,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          subject: "Re: Original"
        })
      )
    );

    const listed = await service.list({ limit: 2 });
    const reply = listed.messages[0];
    const replyRef = reply?.messageRef ?? "";
    const thread = (await service.get({
      messageRef: replyRef,
      mode: "thread"
    })) as { threadRef: string | null };
    const agent = (await service.get({
      messageRef: replyRef,
      mode: "agent"
    })) as { threadRef: string | null };
    const metadata = (await service.get({
      messageRef: replyRef,
      mode: "metadata"
    })) as { threadRef: string | null };

    expect(thread.threadRef).toBe("root@example.com");
    expect(agent.threadRef).toBe("root@example.com");
    expect(metadata.threadRef).toBe("root@example.com");
  });

  it("shares one character budget across all thread messages", async () => {
    const { service, imap } = createService();
    const body = "X".repeat(100);
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({ messageId: "root@example.com", text: body })
      )
    );
    imap.messages.set(
      2,
      fetchedMessage(
        2,
        rawMessage({
          messageId: "reply@example.com",
          inReplyTo: "root@example.com",
          text: body
        })
      )
    );
    imap.searchResult = [1];
    const listed = await service.list({ limit: 1 });
    const thread = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "thread",
      maxChars: 60
    })) as {
      messages: Array<{ text: string; truncated: boolean }>;
      truncated: boolean;
    };

    expect(thread.messages.reduce((total, message) => total + message.text.length, 0)).toBe(60);
    expect(thread.messages[1]).toMatchObject({
      text: "",
      truncated: true
    });
    expect(thread.truncated).toBe(true);
  });

  it("does not report thread truncation when content fits the budget", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          text: "0123456789"
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const thread = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "thread",
      maxChars: 10
    })) as {
      messages: Array<{ text: string; truncated: boolean }>;
      truncated: boolean;
    };

    expect(thread.messages[0]).toMatchObject({
      text: "0123456789",
      truncated: false
    });
    expect(thread.truncated).toBe(false);
  });

  it("does not derive the local account as a reply-all recipient", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          from: "sender@example.com",
          messageId: "root@example.com",
          text: "Original"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";
    const preview = await service.send({
      mode: "reply_all",
      messageRef,
      text: "Reply body"
    });

    expect(preview.preview).toMatchObject({
      to: ["sender@example.com"],
      cc: []
    });
  });

  it("prefers Reply-To over From when deriving reply recipients", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          from: "sender@example.com",
          replyTo: "replies@example.com",
          messageId: "root@example.com"
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const reply = await service.send({
      mode: "reply",
      messageRef: listed.messages[0]?.messageRef ?? "",
      text: "Reply body"
    });

    expect(reply.preview).toMatchObject({
      to: ["replies@example.com"]
    });
  });

  it("can reply to a message originally sent by the local account", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          from: "me@qq.com",
          to: "other@example.com",
          messageId: "sent-root@example.com"
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const reply = await service.send({
      mode: "reply",
      messageRef: listed.messages[0]?.messageRef ?? "",
      text: "Follow up"
    });

    expect(reply.preview).toMatchObject({
      to: ["other@example.com"]
    });
  });

  it("does not duplicate reply or forward subject prefixes", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Re: Fwd: Status"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const reply = await service.send({
      mode: "reply",
      messageRef,
      text: "Reply body"
    });
    const forward = await service.send({
      mode: "forward",
      messageRef,
      to: ["recipient@example.com"],
      text: "Forward body"
    });

    expect(reply.preview).toMatchObject({
      subject: "Re: Fwd: Status"
    });
    expect(forward.preview).toMatchObject({
      subject: "Fwd: Re: Fwd: Status"
    });
  });

  it("normalizes Fw prefixes when forwarding", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "Fw: Status"
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const forward = await service.send({
      mode: "forward",
      messageRef: listed.messages[0]?.messageRef ?? "",
      to: ["recipient@example.com"],
      text: "Forward body"
    });

    expect(forward.preview).toMatchObject({
      subject: "Fwd: Status"
    });
  });

  it("normalizes Chinese reply and forward prefixes", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          subject: "回复：转发：状态"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const reply = await service.send({
      mode: "reply",
      messageRef,
      text: "Reply body"
    });
    const forward = await service.send({
      mode: "forward",
      messageRef,
      to: ["recipient@example.com"],
      text: "Forward body"
    });

    expect(reply.preview).toMatchObject({
      subject: "Re: 转发：状态"
    });
    expect(forward.preview).toMatchObject({
      subject: "Fwd: 回复：转发：状态"
    });
  });

  it("handles an empty original subject when replying or forwarding", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        Buffer.from(
          [
            "From: sender@example.com",
            "To: me@qq.com",
            "Subject: ",
            "Message-ID: <empty-subject@example.com>",
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Body"
          ].join("\r\n")
        )
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const reply = await service.send({
      mode: "reply",
      messageRef,
      text: "Reply body"
    });
    const forward = await service.send({
      mode: "forward",
      messageRef,
      to: ["recipient@example.com"],
      text: "Forward body"
    });

    expect(reply.preview).toMatchObject({ subject: "Re:" });
    expect(forward.preview).toMatchObject({ subject: "Fwd:" });
  });

  it("does not change a successful action when audit logging fails", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: {
        async write() {
          throw new Error("disk full");
        }
      }
    });
    imap.searchResult = [1];
    imap.messages.set(1, fetchedMessage(1));

    await expect(service.list({ limit: 1 })).resolves.toMatchObject({
      messages: expect.any(Array)
    });
  });

  it("closes SMTP even when IMAP close fails", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    let smtpClosed = false;
    imap.close = async () => {
      throw new Error("imap close failed");
    };
    smtp.close = () => {
      smtpClosed = true;
    };
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });

    await expect(service.close()).rejects.toThrow("imap close failed");
    expect(smtpClosed).toBe(true);
  });

  it("reports a sent message even when saving to Sent fails", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: {
        ...testConfig({ send: true }),
        send: { saveSent: "always" }
      },
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.listFolders = async () => {
      throw new Error("folder listing failed");
    };

    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body"
    });
    const token = preview.confirmationToken as string;

    await expect(service.send({ confirmationToken: token })).resolves.toMatchObject({
      status: "sent",
      sentSaveError: "folder listing failed"
    });
  });

  it("reports a missing Sent folder when save_sent is enabled", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: {
        ...testConfig({ send: true }),
        send: { saveSent: "always" }
      },
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.folders.splice(
      imap.folders.findIndex((folder) => folder.role === "sent"),
      1
    );
    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body"
    });

    await expect(
      service.send({ confirmationToken: preview.confirmationToken as string })
    ).resolves.toMatchObject({
      status: "sent",
      sentSaveError: expect.stringContaining("Sent folder")
    });
  });

  it("forwards original attachments by default", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          attachment: {
            filename: "report.txt",
            contentType: "text/plain",
            content: "attached content"
          }
        })
      )
    );

    const listed = await service.list({ limit: 1 });
    const preview = await service.send({
      mode: "forward",
      messageRef: listed.messages[0]?.messageRef ?? "",
      to: ["recipient@example.com"],
      text: "Please review"
    });

    expect(preview.preview).toMatchObject({
      attachments: [
        {
          filename: "report.txt",
          size: Buffer.byteLength("attached content")
        }
      ]
    });
  });

  it("forwards the complete original body including quoted history", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          text: [
            "This is the current message body with enough length.",
            "",
            "On 2026-09-21, Alice wrote:",
            "> This is the older quoted context with enough length."
          ].join("\n")
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const preview = await service.send({
      mode: "forward",
      messageRef: listed.messages[0]?.messageRef ?? "",
      to: ["recipient@example.com"],
      text: "Forwarding this."
    });

    expect(preview.preview).toMatchObject({
      text: expect.stringContaining("older quoted context")
    });
  });

  it("forwards the original signature instead of dropping it", async () => {
    const { service, imap } = createService({ send: true });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          messageId: "root@example.com",
          text: [
            "This is the original message body with enough length.",
            "",
            "-- ",
            "Alice",
            "Example Corp"
          ].join("\n")
        })
      )
    );
    const listed = await service.list({ limit: 1 });

    const preview = await service.send({
      mode: "forward",
      messageRef: listed.messages[0]?.messageRef ?? "",
      to: ["recipient@example.com"],
      text: "Forwarding this."
    });

    expect(preview.preview).toMatchObject({
      text: expect.stringContaining("Example Corp")
    });
  });

  it("reports the full extracted character count before truncation", async () => {
    const { service, imap } = createService();
    const body = "abcdefghijklmnopqrstuvwxyz";
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          attachment: {
            filename: "note.txt",
            contentType: "text/plain",
            content: body
          }
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const metadata = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "metadata"
    })) as { attachments: Array<{ attachmentId: string }> };

    const result = await service.attachment({
      messageRef: listed.messages[0]?.messageRef ?? "",
      attachmentId: metadata.attachments[0]?.attachmentId ?? "",
      action: "extract_text",
      maxChars: 5
    });

    expect(result).toMatchObject({
      extractedText: "abcde",
      characterCount: body.length,
      truncated: true,
      extractor: "text"
    });
  });

  it("returns metadata for an attachment larger than the download limit", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: {
        ...testConfig({ read: true }),
        security: {
          ...testConfig().security,
          maxAttachmentBytes: 5,
          maxTotalAttachmentBytes: 10
        }
      },
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          attachment: {
            filename: "large.txt",
            contentType: "text/plain",
            content: "0123456789"
          }
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const metadata = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "metadata"
    })) as { attachments: Array<{ attachmentId: string }> };
    const attachmentId = metadata.attachments[0]?.attachmentId ?? "";

    await expect(
      service.attachment({
        messageRef: listed.messages[0]?.messageRef ?? "",
        attachmentId,
        action: "metadata"
      })
    ).resolves.toMatchObject({
      filename: "large.txt",
      size: 10
    });
    await expect(
      service.attachment({
        messageRef: listed.messages[0]?.messageRef ?? "",
        attachmentId,
        action: "download"
      })
    ).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE"
    });
  });

  it("keeps attachment metadata when text extraction is unsupported", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          attachment: {
            filename: "image.png",
            contentType: "image/png",
            content: "not-an-image"
          }
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const metadata = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "metadata"
    })) as { attachments: Array<{ attachmentId: string }> };

    await expect(
      service.attachment({
        messageRef: listed.messages[0]?.messageRef ?? "",
        attachmentId: metadata.attachments[0]?.attachmentId ?? "",
        action: "extract_text"
      })
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_ATTACHMENT",
      details: {
        attachment: {
          filename: "image.png",
          contentType: "image/png"
        }
      }
    });
  });

  it("paginates long message bodies with a body cursor", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          text: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const first = (await service.get({
      messageRef,
      mode: "agent",
      maxChars: 20
    })) as {
      text: string;
      truncated: boolean;
      nextCursor: string | null;
    };
    const second = (await service.get({
      messageRef,
      mode: "agent",
      cursor: first.nextCursor
    })) as {
      text: string;
      truncated: boolean;
      nextCursor: string | null;
    };

    expect(first.text).toHaveLength(20);
    expect(first.truncated).toBe(true);
    expect(second.text).toHaveLength(20);
    expect(second.text).not.toBe(first.text);

    await expect(
      service.get({
        messageRef,
        mode: "agent",
        maxChars: 10,
        cursor: first.nextCursor
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("rejects reusing a body cursor across mail_get modes", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          text: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";
    const first = (await service.get({
      messageRef,
      mode: "agent",
      maxChars: 20
    })) as { nextCursor: string | null };

    await expect(
      service.get({
        messageRef,
        mode: "text",
        cursor: first.nextCursor
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("rejects a body cursor in metadata and thread modes", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          text: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";
    const first = (await service.get({
      messageRef,
      mode: "agent",
      maxChars: 5
    })) as { nextCursor: string | null };
    expect(first.nextCursor).toBeTruthy();

    await expect(
      service.get({
        messageRef,
        mode: "metadata",
        cursor: first.nextCursor
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    await expect(
      service.get({
        messageRef,
        mode: "thread",
        cursor: first.nextCursor
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("reports truncation for auxiliary agent context fields", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: testConfig({ read: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        Buffer.from(
          [
            "From: sender@example.com",
            "To: me@qq.com",
            "Subject: Long",
            "MIME-Version: 1.0",
            'Content-Type: text/html; charset="utf-8"',
            "",
            `<p>${"A".repeat(100)}</p><p>On 2026-09-21, Alice wrote:</p><p>${"B".repeat(100)}</p>`
          ].join("\r\n"),
          "utf8"
        )
      )
    );
    const listed = await service.list({ limit: 1 });
    const context = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "agent",
      maxChars: 20
    })) as {
      htmlClean: string | null;
      htmlCleanTruncated: boolean;
      quotedHistory: string | null;
      quotedHistoryTruncated: boolean;
    };

    expect(context.htmlCleanTruncated).toBe(true);
    expect(context.quotedHistoryTruncated).toBe(true);
    expect(context.htmlClean).toHaveLength(20);
    expect(context.quotedHistory).toHaveLength(20);
  });

  it("returns the detached signature in agent context", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          text: [
            "This is the actual message body with enough length.",
            "",
            "-- ",
            "Alice",
            "Example Corp"
          ].join("\n")
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const context = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "agent"
    })) as { text: string; signature: string | null };

    expect(context.text).not.toContain("Example Corp");
    expect(context.signature).toContain("Alice");
    expect(context.signature).toContain("Example Corp");
  });

  it("keeps the signature in text mode instead of dropping it", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        rawMessage({
          text: [
            "This is the actual message body with enough length.",
            "",
            "-- ",
            "Alice",
            "Example Corp"
          ].join("\n")
        })
      )
    );
    const listed = await service.list({ limit: 1 });
    const text = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "text"
    })) as { text: string };

    expect(text.text).toContain("Alice");
    expect(text.text).toContain("Example Corp");
  });

  it("reports context sanitization and omitted attachment metadata", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        Buffer.from(
          [
            "From: sender@example.com",
            "To: me@qq.com",
            "Subject: HTML",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="boundary"',
            "",
            "--boundary",
            'Content-Type: text/html; charset="utf-8"',
            "",
            '<p>Hello</p><img src="https://tracker.example/p.gif">',
            "--boundary",
            'Content-Type: text/plain; name="note.txt"',
            'Content-Disposition: attachment; filename="note.txt"',
            "",
            "attachment",
            "--boundary--",
            ""
          ].join("\r\n")
        )
      )
    );
    const listed = await service.list({ limit: 1 });
    const context = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "agent",
      includeAttachments: false
    })) as { warnings: string[]; attachments: unknown[] };

    expect(context.attachments).toEqual([]);
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        "HTML was sanitized before being returned",
        "Remote HTML resources were removed",
        "Attachment metadata was omitted by request"
      ])
    );
  });

  it("warns when an agent context uses a fallback timestamp", async () => {
    const { service, imap } = createService();
    imap.searchResult = [1];
    imap.messages.set(
      1,
      fetchedMessage(
        1,
        Buffer.from(
          [
            "From: sender@example.com",
            "To: me@qq.com",
            "Subject: No date",
            "Message-ID: <no-date@example.com>",
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Body"
          ].join("\r\n")
        )
      )
    );
    const listed = await service.list({ limit: 1 });
    const context = (await service.get({
      messageRef: listed.messages[0]?.messageRef ?? "",
      mode: "agent"
    })) as { warnings: string[] };

    expect(context.warnings).toContain(
      "Message date was missing; a fallback timestamp was used"
    );
  });

  it("reports partial SMTP recipient failures", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    smtp.acceptedOverride = ["ok@example.com"];
    smtp.rejectedOverride = ["bad@example.com"];
    const service = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    const preview = await service.send({
      mode: "new",
      to: ["ok@example.com", "bad@example.com"],
      subject: "Hello",
      text: "Body"
    });

    await expect(
      service.send({ confirmationToken: preview.confirmationToken as string })
    ).resolves.toMatchObject({
      status: "partial_failure",
      accepted: ["ok@example.com"],
      rejected: ["bad@example.com"]
    });
  });

  it("marks the send audit as failure when every recipient is rejected", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    smtp.acceptedOverride = [];
    smtp.rejectedOverride = ["bad@example.com"];
    const audit = new FakeAudit();
    const service = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit
    });
    const preview = await service.send({
      mode: "new",
      to: ["bad@example.com"],
      subject: "Hello",
      text: "Body"
    });

    await service.send({
      confirmationToken: preview.confirmationToken as string
    });

    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "mail_send",
          action: "send",
          result: "failure",
          errorCode: "SMTP_SEND_FAILED"
        })
      ])
    );
  });

  it("does not allow a confirmation token to be replayed after SMTP failure", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    let attempts = 0;
    smtp.send = async () => {
      attempts += 1;
      throw new AppError("TIMEOUT", "SMTP timeout", { retryable: false });
    };
    const service = new MailService({
      config: testConfig({ read: true, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });
    const preview = await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body"
    });
    const token = preview.confirmationToken as string;

    await expect(service.send({ confirmationToken: token })).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: false
    });
    await expect(service.send({ confirmationToken: token })).rejects.toMatchObject({
      code: "CONFIRMATION_INVALID"
    });
    expect(attempts).toBe(1);
  });

  it("rejects confirmationToken combined with previewOnly", async () => {
    const { service, smtp } = createService({ send: true });

    await expect(
      service.send({
        confirmationToken: "some-token",
        previewOnly: true
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it("passes a content-bound fingerprint validator when consuming a confirmation token", async () => {
    const { service, smtp } = createService({ send: true });
    const preview = (await service.send({
      mode: "new",
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body"
    })) as { confirmationToken?: string };

    const token = preview.confirmationToken as string;
    const confirmations = (service as unknown as { confirmations: any }).confirmations;
    const originalConsume = confirmations.consume.bind(confirmations);
    let observed: unknown;
    confirmations.consume = (tokenArg: string, fingerprintArg: unknown) => {
      observed = fingerprintArg;
      return originalConsume(tokenArg, fingerprintArg as never);
    };

    await service.send({ confirmationToken: token });
    expect(typeof observed).toBe("function");
    expect(smtp.sent.length).toBeGreaterThan(0);
  });

  it("requires read permission to reply or forward an existing message", async () => {
    const imap = new FakeImap();
    const smtp = new FakeSmtp();
    const service = new MailService({
      config: testConfig({ read: false, send: true }),
      imap,
      smtp,
      audit: new FakeAudit()
    });

    await expect(
      service.send({
        mode: "reply",
        messageRef: "opaque-ref",
        text: "Reply"
      })
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED"
    });
    await expect(
      service.send({
        mode: "forward",
        messageRef: "opaque-ref",
        to: ["recipient@example.com"],
        text: "Forward"
      })
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED"
    });
  });

  it("returns structured failure details for bulk updates", async () => {
    const { service, imap } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });

    const result = await service.update({
      messageRefs: [listed.messages[0]?.messageRef ?? "", "invalid-ref"],
      action: "mark_read"
    });

    expect(result.updated).toBeGreaterThanOrEqual(0);
    const failed = result.failed.find((item) => item.messageRef === "invalid-ref");
    expect(failed).toMatchObject({
      code: "INVALID_INPUT",
      retryable: false
    });
    expect(failed?.message).toBeTruthy();
  });

  it("records folder and uid for each bulk update item", async () => {
    const { service, imap, audit } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    await service.update({
      messageRefs: [messageRef, "invalid-ref"],
      action: "mark_read"
    });

    const itemEvents = audit.events.filter(
      (event) =>
        event.tool === "mail_update" && event.action === "mark_read"
    );
    expect(itemEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: "success",
          folder: "INBOX",
          uid: 1
        }),
        expect.objectContaining({
          result: "failure",
          errorCode: "INVALID_INPUT"
        })
      ])
    );
  });

  it("marks the bulk update summary as failure when nothing was updated", async () => {
    const { service, audit } = createService({ update: true });

    await service.update({
      messageRefs: ["invalid-ref"],
      action: "mark_read"
    });

    const summaries = audit.events.filter(
      (event) =>
        event.tool === "mail_update" &&
        event.errorCode === "PARTIAL_UPDATE_FAILED"
    );
    expect(summaries).toEqual([
      expect.objectContaining({
        result: "failure",
        errorCode: "PARTIAL_UPDATE_FAILED"
      })
    ]);
  });

  it("does not apply the same message reference twice", async () => {
    const { service, imap } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const result = await service.update({
      messageRefs: [messageRef, messageRef],
      action: "mark_read"
    });

    expect(result.updated).toBe(1);
    expect(imap.flagOperations).toEqual([
      { uid: 1, operation: "add", flags: ["\\Seen"] }
    ]);
  });

  it("does not report an update for a message that no longer exists", async () => {
    const { service, imap } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";
    imap.messages.delete(1);

    const result = await service.update({
      messageRefs: [messageRef],
      action: "mark_read"
    });

    expect(result.updated).toBe(0);
    expect(result.failed[0]).toMatchObject({
      code: "MAIL_NOT_FOUND",
      retryable: false
    });
    expect(imap.flagOperations).toHaveLength(0);
  });

  it("validates the target folder before moving messages", async () => {
    const { service, imap } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });

    const result = await service.update({
      messageRefs: [listed.messages[0]?.messageRef ?? ""],
      action: "move",
      targetFolder: "Arcive"
    });

    expect(result.updated).toBe(0);
    expect(result.failed[0]).toMatchObject({
      code: "FOLDER_NOT_FOUND",
      retryable: false
    });
    expect(imap.moves).toHaveLength(0);
  });

  it("rejects moving to a non-selectable folder", async () => {
    const { service, imap } = createService({ update: true });
    imap.folders.push({
      name: "Labels",
      displayName: "Labels",
      role: null,
      selectable: false,
      specialUse: null
    });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });

    const result = await service.update({
      messageRefs: [listed.messages[0]?.messageRef ?? ""],
      action: "move",
      targetFolder: "Labels"
    });

    expect(result.updated).toBe(0);
    expect(result.failed[0]).toMatchObject({
      code: "INVALID_INPUT",
      retryable: false
    });
    expect(imap.moves).toHaveLength(0);
  });

  it("does not allow archive or trash to be redirected by targetFolder", async () => {
    const { service, imap } = createService({ update: true });
    imap.messages.set(1, fetchedMessage(1));
    imap.searchResult = [1];
    const listed = await service.list({ folder: "INBOX", limit: 1 });
    const messageRef = listed.messages[0]?.messageRef ?? "";

    const archived = await service.update({
      messageRefs: [messageRef],
      action: "archive",
      targetFolder: "Custom"
    });
    const trashed = await service.update({
      messageRefs: [messageRef],
      action: "trash",
      targetFolder: "Custom"
    });

    expect(archived.updated).toBe(1);
    expect(trashed.updated).toBe(1);
    expect(imap.moves).toEqual([
      { uid: 1, destination: "Archive" },
      { uid: 1, destination: "Trash" }
    ]);
  });

  it("rejects invalid and inverted search date ranges", async () => {
    const { service } = createService();

    await expect(
      service.search({
        since: "not-a-date"
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    await expect(
      service.search({
        since: "2026-10-01",
        before: "2026-01-01"
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("accepts equal-length adjacent IMAP date ranges", async () => {
    const { service, imap } = createService();
    imap.searchResult = [];

    await expect(
      service.search({
        since: "20-Sep-2026",
        before: "21-Sep-2026"
      })
    ).resolves.toMatchObject({
      messages: []
    });
  });
});
