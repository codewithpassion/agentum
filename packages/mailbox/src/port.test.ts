import { describe, expect, test } from "bun:test";
import { memoryFileBlobs } from "@repo/services/files/memory";
import {
  type InboundMessage,
  type MailboxRef,
  MailError,
  type OutgoingDraft,
} from "@repo/services/mail/types";
import { createMailboxPort, type MailboxClient } from "./port.ts";
import type { EmailSender, SendMessage } from "./send.ts";
import { createMailboxStore, SEND_LIMIT_PER_HOUR } from "./store.ts";
import { testMailboxDb } from "./test-db.ts";

const REF: MailboxRef = { mailboxId: "mb1", workspaceId: "ws1" };
const AGENT = "agent@mail.example";
const START = Date.parse("2026-10-27T12:00:00.000Z");

const setup = () => {
  const db = testMailboxDb();
  let ticks = 0;
  // Every call to now() is one second later, so mails sort in the order they arrive.
  const now = () => {
    ticks += 1;
    return new Date(START + ticks * 1000);
  };
  const store = createMailboxStore(db, { now });
  const client = Object.fromEntries(
    Object.entries(store).map(([name, fn]) => [
      name,
      (...args: unknown[]) =>
        Promise.resolve((fn as (...a: unknown[]) => unknown)(...args)),
    ])
  ) as unknown as MailboxClient;
  const files = memoryFileBlobs();
  const sent: SendMessage[] = [];
  const state = { failWith: null as Error | null };
  const sender: EmailSender = {
    send: (message) => {
      if (state.failWith) {
        return Promise.reject(state.failWith);
      }
      sent.push(message);
      return Promise.resolve({ messageId: "ignored" });
    },
  };
  let counter = 0;
  const port = createMailboxPort({
    files,
    mailbox: () => client,
    newId: () => {
      counter += 1;
      return `id${counter}`;
    },
    now,
    sender,
  });
  return { files, port, sent, state, store };
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const inbound = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  attachments: [],
  cc: [],
  envelopeFrom: "person@ext.example",
  envelopeTo: AGENT,
  from: { address: "Person@Ext.example", name: "Person" },
  headers: {},
  inReplyTo: null,
  messageId: "<m1@ext.example>",
  raw: bytes("raw mime of m1"),
  references: [],
  subject: "Hello",
  text: "Hi agent",
  to: [{ address: AGENT }],
  ...overrides,
});

const draft = (overrides: Partial<OutgoingDraft> = {}): OutgoingDraft => ({
  cc: [],
  from: AGENT,
  subject: "Hello there",
  text: "Hi person",
  to: ["person@ext.example"],
  ...overrides,
});

const foldersOf = async (
  port: ReturnType<typeof createMailboxPort>,
  threadId: string
): Promise<string[]> => {
  const thread = await port.readThread(REF, threadId);
  return (thread?.messages ?? []).map((m) => m.folder);
};

const readAll = async (stream: ReadableStream<Uint8Array>) =>
  new TextDecoder().decode(await new Response(stream).arrayBuffer());

describe("storeInbound", () => {
  test("stores the mail, its raw MIME and its attachments", async () => {
    const { files, port } = setup();
    const result = await port.storeInbound(
      REF,
      inbound({
        attachments: [
          {
            content: bytes("pdf bytes"),
            contentId: "cid1",
            disposition: "attachment",
            filename: "a/b.pdf",
            mimetype: "application/pdf",
          },
        ],
      })
    );

    expect(result.duplicate).toBe(false);
    expect(result.messageId).toBe("id1");
    expect(result.threadId).toBe("id1");
    expect(result.attachments).toEqual([
      {
        contentId: "cid1",
        disposition: "attachment",
        filename: "a_b.pdf",
        id: "id2",
        mimetype: "application/pdf",
        size: 9,
      },
    ]);
    expect([...files.objects.keys()].sort()).toEqual([
      "ws1/mail/mb1/id1/id2/a_b.pdf",
      "ws1/mail/mb1/raw/id1.eml",
    ]);
    expect(
      new TextDecoder().decode(
        files.objects.get("ws1/mail/mb1/raw/id1.eml")?.bytes
      )
    ).toBe("raw mime of m1");
  });

  test("a second delivery returns the same ids and writes nothing", async () => {
    const { files, port, store } = setup();
    const first = await port.storeInbound(REF, inbound());
    const filesAfterFirst = files.objects.size;
    const second = await port.storeInbound(REF, inbound());

    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.threadId).toBe(first.threadId);
    expect(files.objects.size).toBe(filesAfterFirst);
    expect(store.listThreads({ limit: 10, page: 1 })[0]?.messageCount).toBe(1);
  });

  test("a mail without a Message-ID dedupes on its raw bytes and never stores the hash as message id", async () => {
    const { port, store } = setup();
    const first = await port.storeInbound(REF, inbound({ messageId: null }));
    const again = await port.storeInbound(REF, inbound({ messageId: null }));
    const other = await port.storeInbound(
      REF,
      inbound({ messageId: null, raw: bytes("different bytes") })
    );

    expect(again.duplicate).toBe(true);
    expect(again.messageId).toBe(first.messageId);
    expect(other.duplicate).toBe(false);
    expect(store.getEmail(first.messageId)?.messageId).toBeNull();
    expect(store.getEmail(first.messageId)?.dedupeKey).toStartWith("sha256:");
  });

  test("keeps only a lowercase address and the header subset", async () => {
    const { port, store } = setup();
    const { messageId } = await port.storeInbound(
      REF,
      inbound({
        headers: { autoSubmitted: "auto-replied", listId: "<list.ext>" },
        references: ["<r0@ext.example>"],
      })
    );
    const row = store.getEmail(messageId);
    expect(row?.sender).toBe("person@ext.example");
    expect(row?.recipient).toBe(AGENT);
    const headers = JSON.parse(row?.rawHeaders ?? "[]") as {
      key: string;
      value: string;
    }[];
    expect(headers.map((h) => h.key)).toEqual([
      "message-id",
      "references",
      "from",
      "to",
      "auto-submitted",
      "list-id",
    ]);
    expect(headers.find((h) => h.key === "from")?.value).toBe(
      "Person <Person@Ext.example>"
    );
  });

  test("caps a huge body and keeps an html-only body as html", async () => {
    const { port } = setup();
    const huge = await port.storeInbound(
      REF,
      inbound({
        messageId: "<huge@ext>",
        subject: "Huge",
        text: "x".repeat(2_000_000),
      })
    );
    const htmlOnly = await port.storeInbound(
      REF,
      inbound({
        html: "<p>Hello <b>there</b></p>",
        messageId: "<html@ext>",
        subject: "Html only",
        text: undefined,
      })
    );
    const hugeThread = await port.readThread(REF, huge.threadId);
    const htmlThread = await port.readThread(REF, htmlOnly.threadId);

    const body = hugeThread?.messages[0]?.text ?? "";
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      1_000_000
    );
    expect(body.endsWith("[Message truncated]")).toBe(true);
    expect(htmlThread?.messages[0]?.html).toBe("<p>Hello <b>there</b></p>");
    expect(htmlThread?.messages[0]?.text).toBe("Hello there");
  });
});

describe("send", () => {
  test("delivers without a Message-ID header, records the mail in sent and starts a thread named by its RFC id", async () => {
    const { port, sent } = setup();
    const result = await port.send(REF, draft({ cc: ["Boss@ext.example"] }));

    expect(result.rfcMessageId).toBe("id1@mail.example");
    expect(result.threadId).toBe("id1@mail.example");
    expect(result.messageId).toBe("id1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      cc: ["Boss@ext.example"],
      from: AGENT,
      headers: {},
      subject: "Hello there",
      text: "Hi person",
      to: ["person@ext.example"],
    });
    expect(sent[0]?.html).toContain("Hi person");
    const thread = await port.readThread(REF, result.threadId);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      cc: [{ address: "boss@ext.example" }],
      folder: "sent",
      from: { address: AGENT },
      text: "Hi person",
      to: [{ address: "person@ext.example" }],
    });
  });

  test("a reply from outside to a thread the agent started lands in that thread", async () => {
    const { port } = setup();
    const out = await port.send(REF, draft());
    const reply = await port.storeInbound(
      REF,
      inbound({
        inReplyTo: `<${out.rfcMessageId}>`,
        messageId: "<re1@ext.example>",
        references: [`<${out.rfcMessageId}>`],
        subject: "Re: Hello there",
      })
    );

    expect(reply.threadId).toBe(out.threadId);
    expect(await foldersOf(port, out.threadId)).toEqual(["sent", "inbox"]);
  });

  test("a failed delivery throws send_failed and records nothing", async () => {
    const { port, state, store } = setup();
    state.failWith = new Error("boom");
    const error = await port.send(REF, draft()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).code).toBe("send_failed");
    expect((error as MailError).message).toContain("boom");
    expect(store.listThreads({ limit: 10, page: 1 })).toEqual([]);
  });

  test("an invalid sender or no recipient is a bad_request", async () => {
    const { port, sent } = setup();
    const noDomain = await port
      .send(REF, draft({ from: "nobody" }))
      .catch((e: unknown) => e);
    const noRecipient = await port
      .send(REF, draft({ to: [] }))
      .catch((e: unknown) => e);

    expect((noDomain as MailError).code).toBe("bad_request");
    expect((noRecipient as MailError).code).toBe("bad_request");
    expect(sent).toHaveLength(0);
  });

  test("the hourly limit throws rate_limited before anything is sent", async () => {
    const { port, sent } = setup();
    await Promise.all(
      Array.from({ length: SEND_LIMIT_PER_HOUR }, () => port.send(REF, draft()))
    );
    const error = await port.send(REF, draft()).catch((e: unknown) => e);

    expect((error as MailError).code).toBe("rate_limited");
    expect(sent).toHaveLength(SEND_LIMIT_PER_HOUR);
  });
});

describe("reply", () => {
  const withInbound = async () => {
    const harness = setup();
    const first = await harness.port.storeInbound(
      REF,
      inbound({
        messageId: "<m2@ext.example>",
        references: ["<r0@ext.example>"],
        subject: "Question",
      })
    );
    return { ...harness, first };
  };

  test("answers the newest inbound mail with In-Reply-To and References", async () => {
    const { first, port, sent } = await withInbound();
    const out = await port.reply(
      REF,
      first.threadId,
      draft({ subject: "Re: Question" })
    );

    expect(first.threadId).toBe("r0@ext.example");
    expect(out.threadId).toBe(first.threadId);
    expect(sent[0]?.headers).toMatchObject({
      "In-Reply-To": "<m2@ext.example>",
      References: "<r0@ext.example> <m2@ext.example>",
    });
    expect(await foldersOf(port, first.threadId)).toEqual(["inbox", "sent"]);
  });

  test("a second reply threads against the newest inbound mail, not its own earlier reply", async () => {
    const { first, port, sent } = await withInbound();
    await port.reply(REF, first.threadId, draft());
    await port.storeInbound(
      REF,
      inbound({
        inReplyTo: "<m2@ext.example>",
        messageId: "<m3@ext.example>",
        references: ["<r0@ext.example>", "<m2@ext.example>"],
        subject: "Re: Question",
      })
    );
    await port.reply(REF, first.threadId, draft());

    expect(sent[1]?.headers).toMatchObject({
      "In-Reply-To": "<m3@ext.example>",
      References: "<r0@ext.example> <m2@ext.example> <m3@ext.example>",
    });
  });

  test("a discarded draft is never the parent of a later reply", async () => {
    const { port, sent } = setup();
    const out = await port.send(REF, draft());
    const held = await port.hold(REF, draft(), out.threadId);
    await port.discard(REF, held.messageId);
    await port.reply(REF, out.threadId, draft());

    expect(sent[1]?.headers).toMatchObject({
      "In-Reply-To": `<${out.rfcMessageId}>`,
      References: `<${out.rfcMessageId}>`,
    });
  });

  test("an unknown thread is a bad_request", async () => {
    const { port } = setup();
    const error = await port
      .reply(REF, "nope", draft())
      .catch((e: unknown) => e);
    expect((error as MailError).code).toBe("bad_request");
  });
});

describe("hold, release and discard", () => {
  test("a held new mail waits in drafts and release sends it into sent", async () => {
    const { port, sent, store } = setup();
    const held = await port.hold(REF, draft());

    expect(sent).toHaveLength(0);
    expect(store.getEmail(held.messageId)?.folderId).toBe("draft");
    expect(held.threadId).toBe("id1@mail.example");
    const draftDate = store.getEmail(held.messageId)?.date ?? "";

    const out = await port.release(REF, held.messageId);

    expect(out).toEqual({
      messageId: held.messageId,
      rfcMessageId: "id1@mail.example",
      threadId: held.threadId,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers).toEqual({});
    const row = store.getEmail(held.messageId);
    expect(row?.folderId).toBe("sent");
    expect((row?.date ?? "") > draftDate).toBe(true);
  });

  test("a held reply builds its References chain when it is released", async () => {
    const { port, sent } = setup();
    const inboundMail = await port.storeInbound(
      REF,
      inbound({
        messageId: "<m9@ext.example>",
        references: ["<r0@ext.example>"],
      })
    );
    const held = await port.hold(REF, draft(), inboundMail.threadId);

    expect(held.threadId).toBe(inboundMail.threadId);
    await port.release(REF, held.messageId);

    expect(sent[0]?.headers).toMatchObject({
      "In-Reply-To": "<m9@ext.example>",
      References: "<r0@ext.example> <m9@ext.example>",
    });
    expect(await foldersOf(port, inboundMail.threadId)).toEqual([
      "inbox",
      "sent",
    ]);
  });

  test("a failed release keeps the draft so it can be tried again", async () => {
    const { port, sent, state, store } = setup();
    const held = await port.hold(REF, draft());
    state.failWith = new Error("down");
    const error = await port
      .release(REF, held.messageId)
      .catch((e: unknown) => e);

    expect((error as MailError).code).toBe("send_failed");
    expect(store.getEmail(held.messageId)?.folderId).toBe("draft");
    state.failWith = null;
    await port.release(REF, held.messageId);
    expect(sent).toHaveLength(1);
  });

  test("discard moves the draft to trash and keeps its body", async () => {
    const { port, sent, store } = setup();
    const held = await port.hold(REF, draft());
    await port.discard(REF, held.messageId);

    expect(sent).toHaveLength(0);
    const row = store.getEmail(held.messageId);
    expect(row?.folderId).toBe("trash");
    expect(row?.body).toBe("Hi person");
  });

  test("release and discard refuse a mail that is not held", async () => {
    const { port } = setup();
    const out = await port.send(REF, draft());
    const release = await port
      .release(REF, out.messageId)
      .catch((e: unknown) => e);
    const discard = await port.discard(REF, "unknown").catch((e: unknown) => e);

    expect((release as MailError).code).toBe("bad_request");
    expect((discard as MailError).code).toBe("bad_request");
  });

  test("holding a reply to an unknown thread is a bad_request", async () => {
    const { port } = setup();
    const error = await port
      .hold(REF, draft(), "nope")
      .catch((e: unknown) => e);
    expect((error as MailError).code).toBe("bad_request");
  });
});

describe("reads", () => {
  test("readThread lists the messages in date order and returns null for an unknown thread", async () => {
    const { port } = setup();
    const first = await port.storeInbound(REF, inbound());
    await port.reply(REF, first.threadId, draft());

    const thread = await port.readThread(REF, first.threadId);
    expect(thread?.threadId).toBe(first.threadId);
    expect(await foldersOf(port, first.threadId)).toEqual(["inbox", "sent"]);
    expect(thread?.messages[0]).toMatchObject({
      attachments: [],
      from: { address: "person@ext.example" },
      html: null,
      subject: "Hello",
      text: "Hi agent",
      to: [{ address: AGENT }],
    });
    expect(await port.readThread(REF, "nope")).toBeNull();
  });

  test("listThreads summarises each thread, newest first", async () => {
    const { port } = setup();
    await port.storeInbound(
      REF,
      inbound({ messageId: "<a@ext>", subject: "A" })
    );
    const b = await port.storeInbound(
      REF,
      inbound({ messageId: "<b@ext>", subject: "B" })
    );
    await port.reply(REF, b.threadId, draft({ subject: "Re: B" }));

    const threads = await port.listThreads(REF, { limit: 10, page: 1 });
    expect(threads.map((t) => t.subject)).toEqual(["Re: B", "A"]);
    expect(threads[0]).toMatchObject({
      messageCount: 2,
      participants: ["person@ext.example", AGENT],
      threadId: b.threadId,
      unreadCount: 1,
    });
  });

  test("readAttachment streams the stored bytes for the right message only", async () => {
    const { files, port } = setup();
    const stored = await port.storeInbound(
      REF,
      inbound({
        attachments: [
          {
            content: bytes("hello file"),
            disposition: "attachment",
            filename: "note.txt",
            mimetype: "text/plain",
          },
        ],
      })
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the index can be out of range under noUncheckedIndexedAccess
    const attachmentId = stored.attachments[0]?.id ?? "";

    const found = await port.readAttachment(
      REF,
      stored.messageId,
      attachmentId
    );
    expect(found).toMatchObject({
      filename: "note.txt",
      mimetype: "text/plain",
      size: 10,
    });
    expect(found ? await readAll(found.body) : "").toBe("hello file");
    expect(await port.readAttachment(REF, "other", attachmentId)).toBeNull();
    expect(await port.readAttachment(REF, stored.messageId, "nope")).toBeNull();

    files.objects.clear();
    expect(
      await port.readAttachment(REF, stored.messageId, attachmentId)
    ).toBeNull();
  });
});
