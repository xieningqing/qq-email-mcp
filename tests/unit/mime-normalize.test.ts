import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../../src/mime/normalize.js";

describe("normalizeMessage", () => {
  it("decodes unicode headers, text and attachments", async () => {
    const source = Buffer.from(
      [
        "From: =?UTF-8?B?5byg5LiJ?= <sender@example.com>",
        "To: recipient@example.com",
        "Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=",
        "Date: Sun, 21 Sep 2026 10:00:00 +0800",
        "Message-ID: <message-1@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="boundary"',
        "",
        "--boundary",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Hello from QQ Mail.",
        "--boundary",
        'Content-Type: text/plain; name="note.txt"',
        "Content-Disposition: attachment; filename=\"note.txt\"",
        "",
        "attachment body",
        "--boundary--",
        ""
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.subject).toBe("测试邮件");
    expect(result.from[0]?.address).toBe("sender@example.com");
    expect(result.text).toContain("Hello from QQ Mail.");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.filename).toBe("note.txt");
  });

  it("removes active content and remote images by default", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: HTML",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        '<script>alert(1)</script><img src="https://tracker.example/p.gif"><div style="background-image:url(https://tracker.example/bg.png)">Hello</div>'
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.htmlClean).not.toContain("<script");
    expect(result.htmlClean).not.toContain("https://tracker.example");
    expect(result.htmlClean).not.toContain("url(");
    expect(result.remoteResourcesRemoved).toBe(true);
    expect(result.links).toContain("https://tracker.example/p.gif");
  });

  it("drops unsafe link schemes from extracted links", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Links",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        '<a href="javascript:alert(1)">bad</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD4=">data</a>',
        '<a href="https://ok.example/a">ok</a>',
        '<a href="mailto:hi@example.com">mail</a>'
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.links).toContain("https://ok.example/a");
    expect(result.links).toContain("mailto:hi@example.com");
    expect(result.links.some((link) => link.startsWith("javascript:"))).toBe(false);
    expect(result.links.some((link) => link.startsWith("data:"))).toBe(false);
  });

  it("falls back to HTML text when no plain text part exists", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: HTML only",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        '<div>Hello <strong>AI</strong></div><p>Second&nbsp;line</p>'
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.text).toContain("Hello AI");
    expect(result.text).toContain("Second line");
    expect(result.remoteResourcesRemoved).toBe(false);
  });

  it("decodes named and numeric entities in HTML-only messages", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Entities",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<div>Tom &amp; Jerry &lt;3 &quot;quote&quot; &#39;apos&#39; &#x4F60;&#22909;</div>"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.text).toContain(
      "Tom & Jerry <3 \"quote\" 'apos' 你好"
    );
  });

  it("decodes RFC 2231 encoded attachment filenames", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Attachment",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="boundary"',
        "",
        "--boundary",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body",
        "--boundary",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment;",
        " filename*=UTF-8''%E5%B9%B4%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf",
        "",
        "PDF",
        "--boundary--",
        ""
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.attachments[0]?.filename).toBe("年度报告.pdf");
  });

  it("marks a missing Date header as a fallback timestamp", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: No date",
        "Message-ID: <no-date@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.dateMissing).toBe(true);
    expect(Number.isNaN(Date.parse(result.date))).toBe(false);
  });

  it("marks an unparseable Date header as a fallback timestamp", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Bad date",
        "Date: not-a-real-date",
        "Message-ID: <bad-date@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.dateMissing).toBe(true);
  });

  it("reads a folded Date header from the raw source", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Folded date",
        "Date: Sun, 21 Sep 2026",
        " 10:00:00 +0800",
        "Message-ID: <folded-date@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.dateMissing).toBe(false);
    expect(result.date).toBe("2026-09-21T02:00:00.000Z");
  });

  it("preserves a valid parsed Date header", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Valid date",
        "Date: Sun, 21 Sep 2026 10:00:00 +0800",
        "Message-ID: <valid-date@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.dateMissing).toBe(false);
    expect(result.date).toBe("2026-09-21T02:00:00.000Z");
  });

  it("separates quoted history without losing either part", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Re: Project",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "这是我这次的新回复，请查收附件并确认下一步安排。",
        "",
        "在 2026年9月21日，Alice 写道：",
        "> 这是上一轮的原始内容，用于提供上下文。"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.text).toContain("新回复");
    expect(result.quotedHistory).toContain("上一轮");
    expect(`${result.text}\n${result.quotedHistory}`).toContain("新回复");
  });

  it("does not treat a prose From: phrase as quoted history", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Prose",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "From: my perspective this is still the current message body.",
        "It should not be split into quoted history."
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.quotedHistory).toBeNull();
    expect(result.text).toContain("my perspective");
  });

  it("separates a standard signature from the message body", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Signature",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "This is the actual message body with enough length.",
        "",
        "-- ",
        "Alice",
        "Example Corp"
      ].join("\r\n"),
      "utf8"
    );

    const result = await normalizeMessage(source);

    expect(result.text).toBe("This is the actual message body with enough length.");
    expect(result.signature).toContain("Alice");
    expect(result.signature).toContain("Example Corp");
  });
});
