import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { agentMailboxes, mailMessages, mailThreads } from "@repo/db/schema/mail";
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
import { createMailService } from "./index.ts";
import type { InboundMessage, MailboxPort } from "./types.ts";

const user: Principal = { kind: "user", userId: "u", via: "session", workspaceId: "w" };
const now = "2026-10-27T00:00:00.000Z";
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createMailService>;
let library: ReturnType<typeof createLibraryService>;
let offered: string[];
let port: MailboxPort;
const message = (id = "m"): InboundMessage => ({
  attachments: [], cc: [], envelopeFrom: "sender@example.net", envelopeTo: "a@example.com",
  from: { address: "sender@example.net" }, headers: {}, inReplyTo: null,
  messageId: id, raw: new Uint8Array(), references: [], subject: "Help", text: "Please help", to: [{ address: "a@example.com" }],
});
beforeEach(() => {
  db = migrated(); offered = [];
  db.insert(workspaces).values({ id: "w", clerkOrgId: "org", createdAt: now, name: "W", timezone: "UTC" }).run();
  db.insert(agents).values({ id: "a", workspaceId: "w", createdAt: now, createdBy: "u", instructions: "", model: "fake", name: "A", runtime: "fake", runtimeConfig: "{}", slug: "a", status: "active" }).run();
  db.insert(agentMailboxes).values({ id: "box", agentId: "a", workspaceId: "w", address: "a@example.com", status: "active", createdAt: now }).run();
  db.insert(triggers).values({ id: "mail:box", agentId: "a", workspaceId: "w", createdAt: now, createdBy: "u", kind: "mail", name: "Mail" }).run();
  const clock = { now: () => new Date(now), sleep: async () => {} };
  const atomic = sqliteAtomic(db);
  const blobs = { get: async () => null, put: async () => {} };
  const events = createEventsService({ db, blobs });
  library = createLibraryService({ db, atomic, clock, events, blobs: memoryLibraryBlobs() });
  const runs = createRunsService({ db, atomic, clock, blobs, library,
    adapters: [{ kind: "fake", cancel: async () => {}, dispatch: async (_db, run) => { offered.push(run.id); } }],
    gateways: [{ kind: "none", deliver: async () => {} }],
  });
  port = {
    discard: async () => {}, hold: async () => ({ messageId: "out", threadId: "t" }),
    listThreads: async () => [], readAttachment: async () => null,
    readThread: async () => ({ threadId: "t", messages: [] }),
    release: async () => ({ messageId: "out", threadId: "t", rfcMessageId: "<out>" }),
    reply: async () => ({ messageId: "out", threadId: "t", rfcMessageId: "<out>" }),
    send: async () => ({ messageId: "out", threadId: "t", rfcMessageId: "<out>" }),
    storeInbound: async (_ref, mail) => ({ messageId: mail.messageId ?? "m", threadId: "t", duplicate: false,
      attachments: mail.attachments.map((a, i) => ({ ...a, id: String(i), size: a.content.byteLength })) }),
  };
  service = createMailService({ db, atomic, clock, events, mailbox: port, runs, library });
});
test("first mail starts a task and reply reuses session; redelivery is idempotent", async () => {
  await service.receive(message());
  await service.receive(message("reply"));
  await service.receive(message());
  const rows = db.select().from(runRows).all();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
  expect(db.select().from(sessions).get()).toMatchObject({ origin: "mail", externalKey: "mail:box:t" });
  expect(rows[0]).toMatchObject({ actorKind: "trigger", actorId: "mail:box", replyTarget: '{"kind":"none"}' });
  expect(rows[0]?.inputText).toContain("untrusted");
  expect(db.select().from(mailMessages).all()).toHaveLength(2);
  expect(db.select().from(eventRows).all().filter(e => e.type === "mail.received")).toHaveLength(2);
  expect(await service.threadForTask(user, rows[1]?.id ?? "")).toMatchObject({ subject: "Help" });
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
  await service.receive({ ...message(), headers: { autoSubmitted: "auto-replied" } });
  await service.receive({ ...message(), headers: { listId: "list.example.net" } });
  await service.receive({ ...message(), headers: { precedence: "bulk" } });
  expect(db.select().from(mailMessages).all()).toHaveLength(0);
  await service.receive({ ...message(), headers: { autoSubmitted: "no" } });
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
test("DSN finds original RFC id in attachment and marks outbound bounced once", async () => {
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  await db.insert(mailMessages).values({ id: "out", workspaceId: "w", threadId: thread?.id ?? "", externalMessageId: "out-uuid", direction: "out", fromAddress: '{}', toAddresses: '["recipient@example.net"]', ccAddresses: '[]', subject: "Help", snippet: "", status: "sent", rfcMessageId: "<original@example.com>" });
  const dsn = { ...message("dsn"), headers: { reportType: "delivery-status", autoSubmitted: "auto-generated" }, attachments: [{ filename: "status", mimetype: "message/delivery-status", disposition: "attachment", content: new TextEncoder().encode("Original-Message-ID: <original@example.com>") }] };
  await service.receive(dsn); await service.receive(dsn);
  expect(db.select().from(mailMessages).where(eq(mailMessages.id, "out")).get()?.status).toBe("bounced");
  expect(db.select().from(eventRows).all().filter(e => e.type === "mail.bounced")).toHaveLength(1);
  expect(db.select().from(runRows).all()).toHaveLength(1);
});
test("attachments use each reply run folder, sanitize paths, skip oversized files", async () => {
  const mail = message();
  mail.attachments = [{ filename: "../../note.txt", mimetype: "text/plain", disposition: "attachment", content: new TextEncoder().encode("hello") }, { filename: "large.bin", mimetype: "application/octet-stream", disposition: "attachment", content: new Uint8Array(LIBRARY_FILE_MAX_BYTES + 1) }];
  await service.receive(mail);
  await service.receive({ ...mail, messageId: "reply" });
  for (const run of db.select().from(runRows).all()) {
    expect(run.inputText).toContain("large.bin");
    expect(run.inputText).toContain("Skipped");
    expect(await library.read(user, `agents/a/tasks/${run.id}/mail/note.txt`)).toBeDefined();
    expect(offered).toContain(run.id);
  }
});
test("workspace reads and trigger changes reject outsiders and nonpeople", async () => {
  await service.receive(message());
  const thread = db.select().from(mailThreads).get();
  const outsider = { ...user, workspaceId: "other" } as Principal;
  await expect(service.thread(outsider, thread?.id ?? "")).rejects.toThrow();
  await expect(service.setTrigger({ kind: "system" }, "a", false)).rejects.toThrow();
  expect(await service.threads(user, "a")).toHaveLength(1);
});
