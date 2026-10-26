import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { APPROVAL_TTL_MS, mailToolKey } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { createRequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import { createRunsService } from "../runs.ts";
import { SYSTEM_PRINCIPAL as system } from "../workspaces.ts";
import { createMailOutbound } from "./outbound.ts";
import type { MailboxPort, OutgoingDraft } from "./types.ts";

const user = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
let db: ReturnType<typeof migrated>;
let mail: ReturnType<typeof createMailOutbound>;
let requests: ReturnType<typeof createRequestsService>;
let events: ReturnType<typeof createEventsService>;
let principal: {
  kind: "run";
  workspaceId: string;
  agentId: string;
  runId: string;
};
let now: number;
let calls: string[];
let drafts: OutgoingDraft[];
let resumed: number;
let serial: number;
let mailbox: MailboxPort;
const draft = (to = ["member@example.com"], cc: string[] = []) => ({
  cc,
  subject: "Hello",
  text: "body",
  to,
});
const message = () => db.select().from(mailMessages).get();
const request = () => db.select().from(runRequests).get();
const status = () => db.select().from(runRows).get()?.status;
const answer = (decision: "allow_once" | "always_allow" | "deny") =>
  requests.answer(user, {
    answer: { decision },
    requestId: request()?.id ?? "missing",
    via: "web",
  });

beforeEach(async () => {
  db = migrated();
  now = Date.parse("2026-10-27T00:00:00Z");
  calls = [];
  drafts = [];
  resumed = 0;
  serial = 0;
  const clock = { now: () => new Date(now), sleep: async () => undefined };
  const blobs = { get: async () => null, put: async () => undefined };
  const atomic = sqliteAtomic(db);
  await db.insert(workspaces).values({
    clerkOrgId: "org",
    createdAt: clock.now().toISOString(),
    id: "w",
    name: "Test",
    timezone: "Australia/Sydney",
  });
  events = createEventsService({ blobs, db });
  const runs = createRunsService({
    adapters: [
      {
        cancel: async () => undefined,
        dispatch: async () => undefined,
        kind: "cloud",
        resume: () => {
          resumed += 1;
          return Promise.resolve();
        },
      },
    ],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  const agent = await createAgentsService({ db, events }).create(user, {
    model: "m",
    name: "Agent",
    runtime: "cloud",
  });
  const started = await runs.startRun(user, {
    agentId: agent.id,
    input: { text: "go" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, started.runId);
  principal = {
    agentId: agent.id,
    kind: "run",
    runId: started.runId,
    workspaceId: "w",
  };
  await db.insert(agentMailboxes).values({
    address: "agent@example.com",
    agentId: agent.id,
    createdAt: clock.now().toISOString(),
    id: "box",
    status: "active",
    workspaceId: "w",
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: async () => null },
  });
  const sent = (threadId = "external-thread") => {
    serial += 1;
    return {
      messageId: `external-${serial}`,
      rfcMessageId: `<rfc-${serial}>`,
      threadId,
    };
  };
  mailbox = {
    discard: (_ref, messageId) => {
      calls.push(`discard:${messageId}`);
      return Promise.resolve();
    },
    hold: (_ref, input, threadId) => {
      calls.push("hold");
      drafts.push(input);
      return Promise.resolve(sent(threadId));
    },
    listThreads: async () => [],
    readAttachment: async () => null,
    readThread: async () => null,
    release: (_ref, messageId) => {
      calls.push(`release:${messageId}`);
      return Promise.resolve({
        messageId,
        rfcMessageId: "<released>",
        threadId: "external-thread",
      });
    },
    reply: (_ref, threadId, input) => {
      calls.push(`reply:${threadId}`);
      drafts.push(input);
      return Promise.resolve(sent(threadId));
    },
    send: (_ref, input) => {
      calls.push("send");
      drafts.push(input);
      return Promise.resolve(sent());
    },
    storeInbound: async () => ({
      ...sent(),
      attachments: [],
      duplicate: false,
    }),
  };
  mail = createMailOutbound({
    atomic,
    clock,
    db,
    events,
    mailbox,
    memberDirectory: async (email, org) =>
      email === "member@example.com" && org === "org" ? "u" : null,
    requests,
  });
});

test("inside sends immediately from own address and links thread to task session", async () => {
  expect(await mail.send(principal, draft())).toMatchObject({ status: "sent" });
  expect(calls).toEqual(["send"]);
  expect(drafts[0]?.from).toBe("agent@example.com");
  expect(request()).toBeUndefined();
  expect(message()?.rfcMessageId).toBe("<rfc-1>");
  expect(db.select().from(mailThreads).get()?.sessionId).toBe(
    db.select().from(runRows).get()?.sessionId
  );
});

test("workspace mailbox is inside without directory; members otherwise count as outside", async () => {
  const noDirectory = createMailOutbound({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(now), sleep: async () => undefined },
    db,
    events,
    mailbox,
    requests,
  });
  expect(
    await noDirectory.send(principal, draft([" AGENT@EXAMPLE.COM "]))
  ).toMatchObject({ status: "sent" });
  expect(await noDirectory.send(principal, draft())).toMatchObject({
    status: "held",
  });
});

test("outside cc holds one approval with preview and first unallowed key without pausing", async () => {
  expect(
    await mail.send(principal, {
      ...draft(
        ["member@example.com"],
        [" OUTSIDE@example.com ", "second@example.com"]
      ),
      text: "x".repeat(700),
    })
  ).toMatchObject({ message: "waiting for approval", status: "held" });
  expect(calls).toEqual(["hold"]);
  expect(status()).toBe("running");
  expect(request()).toMatchObject({
    status: "pending",
    toolKey: mailToolKey("outside@example.com"),
    toolName: "mail_send",
    toolUseId: `mail:${message()?.id}`,
  });
  expect(JSON.parse(request()?.display ?? "{}").input).toEqual({
    cc: ["outside@example.com", "second@example.com"],
    from: "agent@example.com",
    preview: "x".repeat(500),
    subject: "Hello",
    to: ["member@example.com"],
  });
  expect(message()?.requestId).toBe(request()?.id);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .some((e) => e.type === "mail.held")
  ).toBe(true);
});

test("allow once releases and emits in session without resuming runtime", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  await answer("allow_once");
  expect(message()?.status).toBe("sent");
  expect(message()?.rfcMessageId).toBe("<released>");
  expect(calls).toEqual(["hold", "release:external-1"]);
  expect(resumed).toBe(0);
  expect(status()).toBe("running");
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .find((e) => e.type === "mail.sent")?.sessionId
  ).toBe(db.select().from(runRows).get()?.sessionId);
  await mail.send(principal, draft(["outside@example.com"]));
  expect(calls.at(-1)).toBe("hold");
});

test("always allow covers all outside recipients and the next mail sends immediately", async () => {
  await mail.send(
    principal,
    draft(["first@example.com"], ["second@example.com"])
  );
  await answer("always_allow");
  expect(
    (await requests.listRules(user, { agentId: principal.agentId })).map(
      (r) => r.toolKey
    )
  ).toEqual([
    mailToolKey("first@example.com"),
    mailToolKey("second@example.com"),
  ]);
  expect(
    await mail.send(
      principal,
      draft(["second@example.com"], ["first@example.com"])
    )
  ).toMatchObject({ status: "sent" });
  expect(calls.at(-1)).toBe("send");
});

test("deny discards and closes without waking the run", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  await answer("deny");
  expect(message()?.status).toBe("rejected");
  expect(calls).toEqual(["hold", "discard:external-1"]);
  expect(resumed).toBe(0);
});

test("an allowed mail that fails to send is marked failed instead of staying held", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  mailbox.release = () => Promise.reject(new Error("send_failed"));
  await answer("allow_once");
  expect(message()?.status).toBe("failed");
});

test("a release that throws keeps the error and the settled view says the send failed", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  mailbox.release = () => Promise.reject(new Error("send_failed"));
  const settled = await answer("always_allow");
  expect(message()).toMatchObject({
    lastError: "send_failed",
    requestId: request()?.id,
    status: "failed",
  });
  expect(settled.status).toBe("answered");
  expect(settled.sendError).toBe("send_failed");
  const failed = db
    .select()
    .from(eventRows)
    .all()
    .find((e) => e.type === "mail.failed");
  expect(JSON.parse(failed?.payload ?? "{}")).toMatchObject({
    error: "send_failed",
    messageId: message()?.id,
    requestId: request()?.id,
  });
  expect(failed?.sessionId).toBe(request()?.sessionId);
});

test("a sent or denied mail has no send error", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  expect((await answer("allow_once")).sendError).toBeNull();
  expect(message()?.lastError).toBeNull();
});

test("a failed approval opening discards the held mail", async () => {
  const broken = createMailOutbound({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(now), sleep: async () => undefined },
    db,
    events,
    mailbox,
    requests: {
      ...requests,
      open: () => Promise.reject(new Error("run ended")),
    },
  });
  await expect(
    broken.send(principal, draft(["outside@example.com"]))
  ).rejects.toThrow("run ended");
  expect(message()?.status).toBe("failed");
  expect(calls).toEqual(["hold", "discard:external-1"]);
});

test("approval survives run completion and expires without restarting the run", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  const run = await loadRun(db, principal.runId);
  if (!run) {
    throw new Error("Missing run");
  }
  await requests.cancelForRun(run);
  expect(request()?.status).toBe("pending");
  await db
    .update(runRows)
    .set({ status: "done" })
    .where(eq(runRows.id, principal.runId));
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
  expect(await mail.reply(principal, threadId, draft())).toMatchObject({
    status: "sent",
  });
  expect(calls.at(-1)).toBe("reply:external-thread");
  await expect(
    mail.reply({ ...principal, agentId: "other" }, threadId, draft())
  ).rejects.toThrow();
  await expect(mail.reply(principal, "missing", draft())).rejects.toThrow();
});

test("refuses user callers, forged agent, dry runs and sender spoofing before writes", async () => {
  await expect(mail.send(user, draft())).rejects.toThrow();
  await expect(
    mail.send({ ...principal, agentId: "other" }, draft())
  ).rejects.toThrow();
  await expect(
    mail.send({ ...principal, dryRun: true }, draft())
  ).rejects.toThrow();
  await expect(
    mail.send(principal, { ...draft(), from: "spoof@example.com" })
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("today counts incoming and currently held per address on the workspace's calendar day", async () => {
  await mail.send(principal, draft(["outside@example.com"]));
  const held = message();
  if (!held) {
    throw new Error("Missing message");
  }
  await db.insert(mailMessages).values([
    {
      ...held,
      createdAt: "2026-10-26T14:00:00.000Z",
      direction: "in",
      externalMessageId: "in-today",
      id: "in-today",
      requestId: null,
      status: "received",
    },
    {
      ...held,
      createdAt: "2026-10-26T12:59:59.000Z",
      direction: "in",
      externalMessageId: "in-yesterday",
      id: "in-yesterday",
      requestId: null,
      status: "received",
    },
  ]);
  expect(await mail.today(user)).toEqual([
    {
      address: "agent@example.com",
      agentId: expect.any(String),
      held: 1,
      in: 1,
    },
  ]);
  await answer("deny");
  expect(await mail.today(user)).toEqual([
    {
      address: "agent@example.com",
      agentId: expect.any(String),
      held: 0,
      in: 1,
    },
  ]);
  await expect(mail.today({ ...user, workspaceId: "other" })).rejects.toThrow();
});

test("an answer selects its own message when several mail approvals share a run", async () => {
  await mail.send(principal, draft(["first@example.com"]));
  const firstId = request()?.id;
  await mail.send(principal, draft(["second@example.com"]));
  const second = db
    .select()
    .from(runRequests)
    .all()
    .find((row) => row.id !== firstId);
  if (!second) {
    throw new Error("Missing second request");
  }
  await requests.answer(user, {
    answer: { decision: "deny" },
    requestId: second.id,
    via: "web",
  });
  expect(
    db
      .select()
      .from(mailMessages)
      .all()
      .map((row) => row.status)
  ).toEqual(["held", "rejected"]);
  expect(calls.at(-1)).toBe("discard:external-2");
});

test("a synchronous answer during request.opened sends once and keeps event order", async () => {
  events.onAppend(async (event) => {
    if (event.type === "request.opened") {
      await answer("allow_once");
    }
  });
  await mail.send(principal, draft(["outside@example.com"]));
  expect(message()?.status).toBe("sent");
  expect(message()?.requestId).toBe(request()?.id);
  expect(calls).toEqual(["hold", "release:external-1"]);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((event) => event.type.startsWith("mail."))
      .map((event) => event.type)
  ).toEqual(["mail.held", "mail.sent"]);
});

test("an outside reply is held with the existing external thread and ask rules do not permit it", async () => {
  await mail.send(principal, draft());
  const threadId = message()?.threadId ?? "missing";
  await requests.setRule(user, {
    agentId: principal.agentId,
    mode: "ask",
    toolKey: mailToolKey("outside@example.com"),
  });
  let heldThread: string | undefined;
  const originalHold = mailbox.hold;
  mailbox.hold = (ref, input, externalThreadId) => {
    heldThread = externalThreadId;
    return originalHold(ref, input, externalThreadId);
  };
  expect(
    await mail.reply(principal, threadId, draft(["outside@example.com"]))
  ).toMatchObject({ status: "held", threadId });
  expect(heldThread).toBe("external-thread");
});
