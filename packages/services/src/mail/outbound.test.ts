import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { agentMailboxes, mailMessages, mailThreads } from "@repo/db/schema/mail";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { APPROVAL_TTL_MS, mailToolKey } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { createRequestsService } from "../requests.ts";
import { createRunsService } from "../runs.ts";
import { loadRun } from "../runs/queries.ts";
import { SYSTEM_PRINCIPAL as system } from "../workspaces.ts";
import { createMailOutbound } from "./outbound.ts";
import type { MailboxPort, OutgoingDraft } from "./types.ts";

const user = { kind: "user", userId: "u", via: "session", workspaceId: "w" } as const;
let db: ReturnType<typeof migrated>;
let mail: ReturnType<typeof createMailOutbound>;
let requests: ReturnType<typeof createRequestsService>;
let events: ReturnType<typeof createEventsService>;
let principal: { kind: "run"; workspaceId: string; agentId: string; runId: string };
let now: number;
let calls: string[];
let drafts: OutgoingDraft[];
let resumed: number;
let serial: number;
let mailbox: MailboxPort;
const draft = (to = ["member@example.com"], cc: string[] = []) => ({ to, cc, subject: "Hello", text: "body" });
const message = () => db.select().from(mailMessages).get();
const request = () => db.select().from(runRequests).get();
const status = () => db.select().from(runRows).get()?.status;
const answer = (decision: "allow_once" | "always_allow" | "deny") => requests.answer(user, {
  requestId: request()?.id ?? "missing", answer: { decision }, via: "web",
});

beforeEach(async () => {
  db = migrated(); now = Date.parse("2026-10-27T00:00:00Z");
  calls = []; drafts = []; resumed = 0; serial = 0;
  const clock = { now: () => new Date(now), sleep: async () => undefined };
  const blobs = { get: async () => null, put: async () => undefined };
  const atomic = sqliteAtomic(db);
  await db.insert(workspaces).values({ id: "w", clerkOrgId: "org", name: "Test", createdAt: clock.now().toISOString(), timezone: "Australia/Sydney" });
  events = createEventsService({ db, blobs });
  const runs = createRunsService({ db, atomic, clock, blobs, devFakeRuntime: false, gateways: [], adapters: [{ kind: "cloud", dispatch: async () => undefined, cancel: async () => undefined, resume: async () => { resumed += 1; } }] });
  const agent = await createAgentsService({ db, events }).create(user, { name: "Agent", model: "m", runtime: "cloud" });
  const started = await runs.startRun(user, { agentId: agent.id, input: { text: "go" }, session: { origin: "ui" } });
  await runs.claimRun(system, started.runId);
  principal = { kind: "run", workspaceId: "w", agentId: agent.id, runId: started.runId };
  await db.insert(agentMailboxes).values({ id: "box", agentId: agent.id, workspaceId: "w", address: "agent@example.com", status: "active", createdAt: clock.now().toISOString() });
  requests = createRequestsService({ db, atomic, clock, events, runs, secrets: { maskerFor: async () => null } });
  const sent = (threadId = "external-thread") => ({ messageId: `external-${++serial}`, threadId, rfcMessageId: `<rfc-${serial}>` });
  mailbox = {
    send: async (_ref, input) => { calls.push("send"); drafts.push(input); return sent(); },
    reply: async (_ref, threadId, input) => { calls.push(`reply:${threadId}`); drafts.push(input); return sent(threadId); },
    hold: async (_ref, input, threadId) => { calls.push("hold"); drafts.push(input); return sent(threadId); },
    release: async (_ref, messageId) => { calls.push(`release:${messageId}`); return { messageId, threadId: "external-thread", rfcMessageId: "<released>" }; },
    discard: async (_ref, messageId) => { calls.push(`discard:${messageId}`); },
    readThread: async () => null, readAttachment: async () => null, listThreads: async () => [],
    storeInbound: async () => ({ ...sent(), duplicate: false, attachments: [] }),
  };
  mail = createMailOutbound({ db, atomic, clock, events, requests, mailbox, memberDirectory: async (email, org) => email === "member@example.com" && org === "org" ? "u" : null });
});

test("inside sends immediately from own address and links thread to task session", async () => {
  expect(await mail.send(principal, draft())).toMatchObject({ status: "sent" });
  expect(calls).toEqual(["send"]);
  expect(drafts[0]?.from).toBe("agent@example.com");
  expect(request()).toBeUndefined();
  expect(message()?.rfcMessageId).toBe("<rfc-1>");
  expect(db.select().from(mailThreads).get()?.sessionId).toBe(db.select().from(runRows).get()?.sessionId);
});

test("workspace mailbox is inside without directory; members otherwise count as outside", async () => {
  const noDirectory = createMailOutbound({ db, atomic: sqliteAtomic(db), clock: { now: () => new Date(now), sleep: async () => undefined }, events, requests, mailbox });
  expect(await noDirectory.send(principal, draft([" AGENT@EXAMPLE.COM "]))).toMatchObject({ status: "sent" });
  expect(await noDirectory.send(principal, draft())).toMatchObject({ status: "held" });
});

test("outside cc holds one approval with preview and first unallowed key without pausing", async () => {
  expect(await mail.send(principal, { ...draft(["member@example.com"], [" OUTSIDE@example.com ", "second@example.com"]), text: "x".repeat(700) })).toMatchObject({ status: "held", message: "waiting for approval" });
  expect(calls).toEqual(["hold"]);
  expect(status()).toBe("running");
  expect(request()).toMatchObject({ toolName: "mail_send", toolUseId: `mail:${message()?.id}`, toolKey: mailToolKey("outside@example.com"), status: "pending" });
  expect(JSON.parse(request()?.display ?? "{}").input).toEqual({ from: "agent@example.com", to: ["member@example.com"], cc: ["outside@example.com", "second@example.com"], subject: "Hello", preview: "x".repeat(500) });
  expect(message()?.requestId).toBe(request()?.id);
  expect(db.select().from(eventRows).all().some((e) => e.type === "mail.held")).toBe(true);
});

test("allow once releases and emits in session without resuming runtime", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  await answer("allow_once");
  expect(message()?.status).toBe("sent");
  expect(message()?.rfcMessageId).toBe("<released>");
  expect(calls).toEqual(["hold", "release:external-1"]);
  expect(resumed).toBe(0);
  expect(status()).toBe("running");
  expect(db.select().from(eventRows).all().find((e) => e.type === "mail.sent")?.sessionId).toBe(db.select().from(runRows).get()?.sessionId);
  await mail.send(principal, draft(["outside@example.com"]));
  expect(calls.at(-1)).toBe("hold");
});

test("always allow covers all outside recipients and the next mail sends immediately", async () => {
  await mail.send(principal, draft(["first@example.com"], ["second@example.com"]));
  await answer("always_allow");
  expect((await requests.listRules(user, { agentId: principal.agentId })).map((r) => r.toolKey)).toEqual([mailToolKey("first@example.com"), mailToolKey("second@example.com")]);
  expect(await mail.send(principal, draft(["second@example.com"], ["first@example.com"]))).toMatchObject({ status: "sent" });
  expect(calls.at(-1)).toBe("send");
});

test("deny discards and closes without waking the run", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  await answer("deny");
  expect(message()?.status).toBe("rejected");
  expect(calls).toEqual(["hold", "discard:external-1"]);
  expect(resumed).toBe(0);
});

test("approval survives run completion and expires without restarting the run", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  const run = await loadRun(db, principal.runId);
  if (!run) { throw new Error("Missing run"); }
  await requests.cancelForRun(run);
  expect(request()?.status).toBe("pending");
  await db.update(runRows).set({ status: "done" }).where(eq(runRows.id, principal.runId));
  now += APPROVAL_TTL_MS + 1;
  await requests.expireDue(system);
  expect(message()?.status).toBe("expired");
  expect(calls).toEqual(["hold", "discard:external-1"]);
  expect(status()).toBe("done");
  expect(resumed).toBe(0);
});

test("reply uses only own mailbox's indexed thread and its external id", async () => {
  await mail.send(principal, draft());
  const threadId = message()?.threadId ?? "missing";
  expect(await mail.reply(principal, threadId, draft())).toMatchObject({ status: "sent" });
  expect(calls.at(-1)).toBe("reply:external-thread");
  await expect(mail.reply({ ...principal, agentId: "other" }, threadId, draft())).rejects.toThrow();
  await expect(mail.reply(principal, "missing", draft())).rejects.toThrow();
});

test("refuses user callers, forged agent, dry runs and sender spoofing before writes", async () => {
  await expect(mail.send(user, draft())).rejects.toThrow();
  await expect(mail.send({ ...principal, agentId: "other" }, draft())).rejects.toThrow();
  await expect(mail.send({ ...principal, dryRun: true }, draft())).rejects.toThrow();
  await expect(mail.send(principal, { ...draft(), from: "spoof@example.com" })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("today counts incoming and currently held per address on the workspace's calendar day", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  const held = message();
  if (!held) { throw new Error("Missing message"); }
  await db.insert(mailMessages).values([
    { ...held, id: "in-today", externalMessageId: "in-today", requestId: null, direction: "in", status: "received", createdAt: "2026-10-26T14:00:00.000Z" },
    { ...held, id: "in-yesterday", externalMessageId: "in-yesterday", requestId: null, direction: "in", status: "received", createdAt: "2026-10-26T12:59:59.000Z" },
  ]);
  expect(await mail.today(user)).toEqual([{ address: "agent@example.com", in: 1, held: 1 }]);
  await answer("deny");
  expect(await mail.today(user)).toEqual([{ address: "agent@example.com", in: 1, held: 0 }]);
  await expect(mail.today({ ...user, workspaceId: "other" })).rejects.toThrow();
});
