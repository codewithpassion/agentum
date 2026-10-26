import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { LIBRARY_FILE_MAX_BYTES } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { createRunsService } from "../runs.ts";
import type { Principal } from "../workspaces.ts";
import { bounceMessageIds } from "./inbound.ts";
import { createMailService } from "./index.ts";
import type { InboundMessage, MailboxPort } from "./types.ts";

const user: Principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
};
const now = "2026-10-27T00:00:00.000Z";
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createMailService>;
let library: ReturnType<typeof createLibraryService>;
let offered: string[];
let port: MailboxPort;
const message = (id = "m"): InboundMessage => ({
  attachments: [],
  cc: [],
  envelopeFrom: "sender@example.net",
  envelopeTo: "a@example.com",
  from: { address: "sender@example.net" },
  headers: {},
  inReplyTo: null,
  messageId: id,
  raw: new Uint8Array(),
  references: [],
  subject: "Help",
  text: "Please help",
  to: [{ address: "a@example.com" }],
});
beforeEach(() => {
  db = migrated();
  offered = [];
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt: now,
      id: "w",
      name: "W",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values({
      createdAt: now,
      createdBy: "u",
      id: "a",
      instructions: "",
      model: "fake",
      name: "A",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "a",
      status: "active",
      workspaceId: "w",
    })
    .run();
  db.insert(agentMailboxes)
    .values({
      address: "a@example.com",
      agentId: "a",
      createdAt: now,
      id: "box",
      status: "active",
      workspaceId: "w",
    })
    .run();
  db.insert(triggers)
    .values({
      agentId: "a",
      createdAt: now,
      createdBy: "u",
      id: "mail:box",
      kind: "mail",
      name: "Mail",
      workspaceId: "w",
    })
    .run();
  const clock = { now: () => new Date(now), sleep: () => Promise.resolve() };
  const atomic = sqliteAtomic(db);
  const blobs = { get: async () => null, put: () => Promise.resolve() };
  const events = createEventsService({ blobs, db });
  library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  const runs = createRunsService({
    adapters: [
      {
        cancel: () => Promise.resolve(),
        dispatch: (_db, run) => {
          offered.push(run.id);
          return Promise.resolve();
        },
        kind: "fake",
      },
    ],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [{ deliver: () => Promise.resolve(), kind: "none" }],
    library,
  });
  port = {
    discard: () => Promise.resolve(),
    hold: async () => ({ messageId: "out", threadId: "t" }),
    listThreads: async () => [],
    readAttachment: async () => null,
    readThread: async () => ({ messages: [], threadId: "t" }),
    release: async () => ({
      messageId: "out",
      rfcMessageId: "<out>",
      threadId: "t",
    }),
    reply: async () => ({
      messageId: "out",
      rfcMessageId: "<out>",
      threadId: "t",
    }),
    send: async () => ({
      messageId: "out",
      rfcMessageId: "<out>",
      threadId: "t",
    }),
    storeInbound: async (_ref, mail) => ({
      attachments: mail.attachments.map((a, i) => ({
        ...a,
        id: String(i),
        size: a.content.byteLength,
      })),
      duplicate: false,
      messageId: mail.messageId ?? "m",
      threadId: "t",
    }),
  };
  service = createMailService({
    atomic,
    clock,
    db,
    events,
    library,
    mailbox: port,
    runs,
  });
});
test("first mail starts a task and reply reuses session; redelivery is idempotent", async () => {
  await service.receive(message());
  await service.receive(message("reply"));
  await service.receive(message());
  const rows = db.select().from(runRows).all();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
  expect(db.select().from(sessions).get()).toMatchObject({
    externalKey: "mail:box:t",
    origin: "mail",
  });
  expect(rows[0]).toMatchObject({
    actorId: "mail:box",
    actorKind: "trigger",
    reply: '{"kind":"none"}',
  });
  expect(rows[0]?.inputText).toContain("untrusted");
  expect(db.select().from(mailMessages).all()).toHaveLength(2);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((e) => e.type === "mail.received")
  ).toHaveLength(2);
  expect(await service.threadForTask(user, rows[1]?.id ?? "")).toMatchObject({
    subject: "Help",
  });
});
test("trigger off and inactive agent store only", async () => {
  await service.setTrigger(user, "a", false);
  await service.receive(message());
  await service.setTrigger(user, "a", true);
  await db.update(agents).set({ status: "draft" });
  await service.receive(message("draft"));
  expect(db.select().from(mailMessages).all()).toHaveLength(2);
  expect(db.select().from(runRows).all()).toHaveLength(0);
});
test("agent loops, auto replies and lists are ignored", async () => {
  await service.receive({ ...message(), from: { address: "A@EXAMPLE.COM" } });
  await service.receive({
    ...message(),
    headers: { autoSubmitted: "auto-replied" },
  });
  await service.receive({
    ...message(),
    headers: { listId: "list.example.net" },
  });
  await service.receive({ ...message(), headers: { precedence: "bulk" } });
  expect(db.select().from(mailMessages).all()).toHaveLength(0);
  await service.receive({ ...message(), headers: { autoSubmitted: "no" } });
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
test("DSN finds original RFC id in attachment and marks outbound bounced once", async () => {
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: now,
    direction: "out",
    externalMessageId: "out-uuid",
    fromAddress: "{}",
    id: "out",
    rfcMessageId: "<original@example.com>",
    snippet: "",
    status: "sent",
    subject: "Help",
    threadId: thread?.id ?? "",
    toAddresses: '["recipient@example.net"]',
    workspaceId: "w",
  });
  const dsn = {
    ...message("dsn"),
    attachments: [
      {
        content: new TextEncoder().encode(
          "Original-Message-ID: <original@example.com>"
        ),
        disposition: "attachment",
        filename: "status",
        mimetype: "message/delivery-status",
      },
    ],
    headers: { autoSubmitted: "auto-generated", reportType: "delivery-status" },
  };
  await service.receive(dsn);
  await service.receive(dsn);
  expect(
    db.select().from(mailMessages).where(eq(mailMessages.id, "out")).get()
      ?.status
  ).toBe("bounced");
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((e) => e.type === "mail.bounced")
  ).toHaveLength(1);
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
test("a read receipt is neither a bounce nor mail for the agent", async () => {
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: now,
    direction: "out",
    externalMessageId: "out-uuid",
    fromAddress: "{}",
    id: "out",
    rfcMessageId: "<original@example.com>",
    snippet: "",
    status: "sent",
    subject: "Help",
    threadId: thread?.id ?? "",
    toAddresses: '["recipient@example.net"]',
    workspaceId: "w",
  });
  await service.receive({
    ...message("receipt"),
    headers: {
      contentType: "multipart/report; report-type=disposition-notification",
      reportType: "disposition-notification",
    },
    inReplyTo: "<original@example.com>",
    text: "Original-Message-ID: <original@example.com>",
  });
  expect(
    db.select().from(mailMessages).where(eq(mailMessages.id, "out")).get()
      ?.status
  ).toBe("sent");
  expect(db.select().from(mailMessages).all()).toHaveLength(2);
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
test("attachments use each reply run folder, sanitize paths, skip oversized files", async () => {
  const mail = message();
  mail.attachments = [
    {
      content: new TextEncoder().encode("hello"),
      disposition: "attachment",
      filename: "../../note.txt",
      mimetype: "text/plain",
    },
    {
      content: new Uint8Array(LIBRARY_FILE_MAX_BYTES + 1),
      disposition: "attachment",
      filename: "large.bin",
      mimetype: "application/octet-stream",
    },
  ];
  await service.receive(mail);
  await service.receive({ ...mail, messageId: "reply" });
  for (const run of db.select().from(runRows).all()) {
    expect(run.inputText).toContain("large.bin");
    expect(run.inputText).toContain("Skipped");
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: verify each reply run folder
      await library.read(user, `agents/a/tasks/${run.id}/mail/note.txt`)
    ).toBeDefined();
    expect(offered).toContain(run.id);
  }
});
test("workspace reads and trigger changes reject outsiders and nonpeople", async () => {
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  const outsider = { ...user, workspaceId: "other" } as Principal;
  await expect(service.thread(outsider, thread?.id ?? "")).rejects.toThrow();
  await expect(
    service.setTrigger({ kind: "system" }, "a", false)
  ).rejects.toThrow();
  await expect(
    service.setTrigger(
      { ...user, apiKey: { access: "read", id: "k" } } as Principal,
      "a",
      false
    )
  ).rejects.toThrow();
  expect(await service.threads(user, "a")).toHaveLength(1);
});

test("bounce ids accept text and DSN header fallbacks", () => {
  expect(
    bounceMessageIds({
      ...message("<dsn>"),
      inReplyTo: "<reply>",
      references: ["<reference>"],
      text: "Original-Message-ID: <original>",
    })
  ).toEqual(["<reply>", "<reference>", "<dsn>", "<original>"]);
});

test("port duplicates repair missing D1 rows and backend bodies join to index status", async () => {
  const store = port.storeInbound;
  port.storeInbound = async (ref, mail) => ({
    ...(await store(ref, mail)),
    duplicate: true,
  });
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  port.readThread = async () => ({
    messages: [
      {
        attachments: [],
        cc: [],
        date: now,
        folder: "inbox",
        from: message().from,
        html: null,
        messageId: "m",
        subject: "Help",
        text: "Full backend body",
        to: message().to,
      },
    ],
    threadId: "t",
  });
  expect(
    (await service.thread(user, thread?.id ?? "")).messages[0]
  ).toMatchObject({ body: { text: "Full backend body" }, status: "received" });
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
