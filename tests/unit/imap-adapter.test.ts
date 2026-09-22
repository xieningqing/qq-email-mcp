import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import { ImapAdapter, type ImapAdapterOptions } from "../../src/adapters/imap-adapter.js";

class FakeClient extends EventEmitter {
  usable = false;
  listCalls = 0;
  moveCalls = 0;
  connectCalls = 0;
  closeCalls = 0;
  mailboxOpenCalls: string[] = [];
  failListOnce = false;
  failMoveOnce = false;
  failConnectOnce = false;
  failFlagsOnce = false;
  failAppendOnce = false;
  flagCalls = 0;
  appendCalls = 0;
  bodyEncoding = "quoted-printable";
  bodyRaw: Buffer | null = null;
  folderPath = "INBOX";
  specialUse: string | null = "\\Inbox";
  failMailboxOpenCode: string | null = null;
  searchCalls = 0;
  fetchCalls: Array<{ range: number[]; query: Record<string, unknown> }> = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnectOnce) {
      this.failConnectOnce = false;
      throw Object.assign(new Error("connect failed"), { code: "CONNECT_TIMEOUT" });
    }
    this.usable = true;
  }

  async mailboxOpen(folder: string) {
    this.mailboxOpenCalls.push(folder);
    if (this.failMailboxOpenCode) {
      throw Object.assign(new Error("mailbox not found"), {
        code: this.failMailboxOpenCode
      });
    }
    return {
      path: folder,
      exists: 1,
      uidValidity: 100n,
      uidNext: 2
    };
  }

  async logout(): Promise<void> {
    this.usable = false;
  }

  close(): void {
    this.closeCalls += 1;
    this.usable = false;
  }

  async list() {
    this.listCalls += 1;
    if (this.failListOnce) {
      this.failListOnce = false;
      this.usable = false;
      this.emit("close");
      throw Object.assign(new Error("connection lost"), { code: "EConnectionClosed" });
    }

    return [
      {
        path: this.folderPath,
        name: this.folderPath,
        delimiter: ".",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
        specialUse: this.specialUse
      }
    ];
  }

  async messageMove(): Promise<{ path: string; destination: string }> {
    this.moveCalls += 1;
    if (this.failMoveOnce) {
      this.failMoveOnce = false;
      this.usable = false;
      this.emit("close");
      throw Object.assign(new Error("connection lost"), { code: "EConnectionClosed" });
    }

    return {
      path: "INBOX",
      destination: "Archive"
    };
  }

  async messageFlagsAdd(): Promise<boolean> {
    this.flagCalls += 1;
    if (this.failFlagsOnce) {
      this.failFlagsOnce = false;
      return false;
    }
    return true;
  }

  async append(): Promise<boolean> {
    this.appendCalls += 1;
    if (this.failAppendOnce) {
      this.failAppendOnce = false;
      return false;
    }
    return true;
  }

  searchResult: number[] | false = [999];

  async search(): Promise<number[] | false> {
    this.searchCalls += 1;
    return this.searchResult;
  }

  async fetchAll(range: number[], query: Record<string, unknown>) {
    this.fetchCalls.push({ range, query });
    if (query.bodyStructure) {
      return [...range].reverse().map((uid) => ({
          uid,
          flags: new Set<string>(),
          internalDate: new Date("2026-09-21T02:00:00.000Z"),
          envelope: {
            subject: "Hello",
            date: new Date("2026-09-21T02:00:00.000Z"),
            from: [{ address: "sender@example.com" }],
            to: [{ address: "me@qq.com" }]
          },
          bodyStructure: {
            type: "multipart/alternative",
            childNodes: [
              {
                part: "1",
                type: "text/plain",
                encoding: this.bodyEncoding,
                parameters: { charset: "utf-8" }
              },
              {
                part: "2",
                type: "text/html",
                encoding: "quoted-printable",
                parameters: { charset: "utf-8" }
              }
            ]
          }
        }));
    }

    const body =
      this.bodyRaw ??
      (this.bodyEncoding === "base64"
        ? Buffer.from(
            Buffer.from("Base64 body preview")
              .toString("base64")
              .slice(0, -2),
            "ascii"
          )
        : Buffer.from("Hello=20from=20QQ=0A=E4=BD=A0=E5=A5=BD", "latin1"));

    return [...range].reverse().map((uid) => ({
        uid,
        bodyParts: new Map([
          ["1", body]
        ])
      }));
  }
}

function createAdapter() {
  const clients: FakeClient[] = [];
  const adapter = new ImapAdapter(
    {
      host: "imap.qq.com",
      port: 993,
      secure: true,
      user: "me@qq.com",
      password: "auth-code"
    } satisfies ImapAdapterOptions,
    () => {
      const client = new FakeClient();
      clients.push(client);
      return client as unknown as ImapFlow;
    }
  );

  return { adapter, clients };
}

describe("ImapAdapter reconnection", () => {
  it("fetches the preferred text part and decodes the summary", async () => {
    const { adapter, clients } = createAdapter();

    const summaries = await adapter.fetchSummaries([7, 8]);

    expect(summaries).toEqual([
      expect.objectContaining({
        uid: 7,
        snippetText: "Hello from QQ 你好"
      }),
      expect.objectContaining({
        uid: 8,
        snippetText: "Hello from QQ 你好"
      })
    ]);
    expect(clients[0]?.fetchCalls).toHaveLength(2);
    expect(clients[0]?.fetchCalls[0]?.query).toMatchObject({
      uid: true,
      envelope: true,
      bodyStructure: true
    });
    expect(clients[0]?.fetchCalls[1]?.query).toMatchObject({
      bodyParts: [{ key: "1", start: 0, maxLength: 4096 }]
    });
  });

  it("decodes a truncated base64 summary without throwing", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.bodyEncoding = "base64";

    const summaries = await adapter.fetchSummaries([7]);

    expect(summaries[0]?.snippetText).toContain("Base64 body preview");
  });

  it("decodes named and numeric HTML entities in summaries", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.bodyRaw = Buffer.from(
      "<p>Tom &amp; Jerry &lt;3 &quot;quote&quot; &#39;apos&#39; &#x4F60;&#22909;</p>",
      "utf8"
    );

    const summaries = await adapter.fetchSummaries([7]);

    expect(summaries[0]?.snippetText).toBe(
      "Tom & Jerry <3 \"quote\" 'apos' 你好"
    );
  });

  it("reuses the currently opened folder", async () => {
    const { adapter, clients } = createAdapter();

    const first = await adapter.openFolder("INBOX");
    const second = await adapter.openFolder("INBOX");

    expect(first.path).toBe("INBOX");
    expect(second.path).toBe("INBOX");
    expect(clients[0]?.mailboxOpenCalls).toEqual(["INBOX"]);
  });

  it("closes the client even when it was never connected", async () => {
    const { adapter, clients } = createAdapter();

    await adapter.close();

    expect(clients[0]?.closeCalls).toBe(1);
  });

  it("maps a nonexistent mailbox to FOLDER_NOT_FOUND", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.failMailboxOpenCode = "NONEXISTENT";

    await expect(adapter.openFolder("Missing")).rejects.toMatchObject({
      code: "FOLDER_NOT_FOUND",
      retryable: false
    });
  });

  it("returns no results for a beforeUid cursor at UID 1", async () => {
    const { adapter, clients } = createAdapter();

    const uids = await adapter.search({ beforeUid: 1 });

    expect(uids).toEqual([]);
    expect(clients[0]?.searchCalls).toBe(0);
  });

  it("reports IMAP SEARCH failure instead of returning an empty result", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.searchResult = false;

    await expect(adapter.search({ query: "invoice" })).rejects.toMatchObject({
      code: "IMAP_OPERATION_FAILED"
    });
  });

  it("returns an empty array when SEARCH legitimately matches nothing", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.searchResult = [];

    await expect(adapter.search({ query: "invoice" })).resolves.toEqual([]);
  });

  it("does not guess folder roles without a server special-use flag", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.specialUse = null;
    clients[0]!.folderPath = "INBOX";

    const folders = await adapter.listFolders();

    expect(folders[0]).toMatchObject({
      name: "INBOX",
      role: null,
      specialUse: null
    });
  });

  it("rebuilds the client after a failed initial connection", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.failConnectOnce = true;

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "TIMEOUT"
    });
    await expect(adapter.connect()).resolves.toBeUndefined();

    expect(clients).toHaveLength(2);
    expect(clients[1]?.connectCalls).toBe(1);
  });

  it("retries a read operation after a disconnect", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.failListOnce = true;

    const folders = await adapter.listFolders();

    expect(folders[0]?.name).toBe("INBOX");
    expect(clients).toHaveLength(2);
    expect(clients[0]?.listCalls).toBe(1);
    expect(clients[1]?.listCalls).toBe(1);
  });

  it("does not retry a write operation after a disconnect", async () => {
    const { adapter, clients } = createAdapter();
    await adapter.connect();
    clients[0]!.failMoveOnce = true;

    await expect(adapter.moveMessage(1, "Archive")).rejects.toMatchObject({
      code: "NETWORK_ERROR"
    });
    expect(clients[0]?.moveCalls).toBe(1);
    expect(clients).toHaveLength(1);
  });

  it("reports a failed flag update instead of treating it as success", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.failFlagsOnce = true;

    await expect(adapter.updateFlags(1, "add", ["\\Seen"])).rejects.toMatchObject({
      code: "IMAP_OPERATION_FAILED"
    });
    expect(clients[0]?.flagCalls).toBe(1);
  });

  it("reports a failed append instead of treating it as success", async () => {
    const { adapter, clients } = createAdapter();
    clients[0]!.failAppendOnce = true;

    await expect(
      adapter.append("Sent", Buffer.from("raw"), ["\\Seen"])
    ).rejects.toMatchObject({
      code: "IMAP_OPERATION_FAILED"
    });
    expect(clients[0]?.appendCalls).toBe(1);
  });
});
