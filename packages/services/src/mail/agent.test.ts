import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "../authz.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createMailAgent } from "./agent.ts";
import type { MailboxPort, ThreadSummary, ThreadView } from "./types.ts";

const now = "2026-10-27T00:00:00.000Z";
const run: Principal = {
  agentId: "a",
  kind: "run",
  runId: "r",
  workspaceId: "w",
};
const stranger: Principal = { ...run, agentId: "other", workspaceId: "w2" };
let db: ReturnType<typeof migrated>;
let calls: { page?: { limit: number; page: number }; thread?: string }[];
const summary = (threadId: string): ThreadSummary => ({
  lastMessageAt: now,
  messageCount: 1,
  participants: ["x@example.net"],
  subject: "Hello",
  threadId,
  unreadCount: 0,
});
const view: ThreadView = {
  messages: [
    {
      attachments: [],
      cc: [],
      date: now,
      folder: "inbox",
      from: { address: "x@example.net" },
      html: null,
      messageId: "do-msg",
      subject: "Hello",
      text: "Hi",
      to: [{ address: "a@example.com" }],
    },
  ],
  threadId: "do-thread",
};
const port: MailboxPort = {
  discard: () => Promise.resolve(),
  hold: async () => ({ messageId: "m", threadId: "t" }),
  listThreads: (_ref, page) => {
    calls.push({ page });
    // The second thread has no D1 row, so it must stay out of the list.
    return Promise.resolve([summary("do-thread"), summary("orphan")]);
  },
  readAttachment: async () => null,
  readThread: (_ref, thread) => {
    calls.push({ thread });
    return Promise.resolve(thread === "do-thread" ? view : null);
  },
  release: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  reply: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  send: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  storeInbound: async () => ({
    attachments: [],
    duplicate: false,
    messageId: "m",
    threadId: "t",
  }),
};
const seedAgent = (id: string, workspaceId: string) =>
  db
    .insert(agents)
    .values({
      createdAt: now,
      createdBy: "u",
      id,
      instructions: "",
      model: "fake",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId,
    })
    .run();

beforeEach(() => {
  db = migrated();
  calls = [];
  for (const id of ["w", "w2"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: `org-${id}`,
        createdAt: now,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  seedAgent("a", "w");
  seedAgent("other", "w2");
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
  db.insert(mailThreads)
    .values({
      externalThreadId: "do-thread",
      id: "d1-thread",
      lastMessageAt: now,
      mailboxId: "box",
      subject: "Hello",
      workspaceId: "w",
    })
    .run();
  db.insert(mailMessages)
    .values({
      ccAddresses: "[]",
      createdAt: now,
      direction: "in",
      externalMessageId: "do-msg",
      fromAddress: "{}",
      id: "d1-msg",
      snippet: "Hi",
      status: "received",
      subject: "Hello",
      threadId: "d1-thread",
      toAddresses: "[]",
      workspaceId: "w",
    })
    .run();
});

test("hasActiveMailbox is true for a run of an agent with an active mailbox", async () => {
  const agent = createMailAgent({ db, mailbox: port });
  expect(await agent.hasActiveMailbox(run)).toBe(true);
  expect(await agent.hasActiveMailbox(stranger)).toBe(false);
  expect(
    await agent.hasActiveMailbox({
      kind: "user",
      userId: "u",
      via: "session",
      workspaceId: "w",
    })
  ).toBe(false);
});

test("hasActiveMailbox is false once the mailbox is disabled", async () => {
  db.update(agentMailboxes).set({ status: "disabled" }).run();
  expect(
    await createMailAgent({ db, mailbox: port }).hasActiveMailbox(run)
  ).toBe(false);
});

test("listThreads returns D1 thread ids and drops threads without a row", async () => {
  const threads = await createMailAgent({ db, mailbox: port }).listThreads(
    run,
    { limit: 20, page: 1 }
  );
  expect(threads.map((t) => t.threadId)).toEqual(["d1-thread"]);
  expect(calls[0]?.page).toEqual({ limit: 20, page: 1 });
});

test("readThread maps ids to D1 and carries the message status", async () => {
  const thread = await createMailAgent({ db, mailbox: port }).readThread(
    run,
    "d1-thread"
  );
  expect(thread?.threadId).toBe("d1-thread");
  expect(thread?.messages[0]?.messageId).toBe("d1-msg");
  expect(thread?.messages[0]?.status).toBe("received");
  expect(calls[0]?.thread).toBe("do-thread");
});

test("readThread is null for an unknown thread and never reads another mailbox's", async () => {
  const agent = createMailAgent({ db, mailbox: port });
  expect(await agent.readThread(run, "nope")).toBeNull();
  await expect(agent.readThread(stranger, "d1-thread")).rejects.toThrow(
    "Active mailbox not found"
  );
});

test("only a run reads its mailbox", async () => {
  await expect(
    createMailAgent({ db, mailbox: port }).listThreads(SYSTEM_PRINCIPAL, {
      limit: 1,
      page: 1,
    })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("isActiveAddress is for the system and matches active mailboxes only", async () => {
  const agent = createMailAgent({ db, mailbox: port });
  expect(await agent.isActiveAddress(SYSTEM_PRINCIPAL, " A@Example.com ")).toBe(
    true
  );
  expect(await agent.isActiveAddress(SYSTEM_PRINCIPAL, "b@example.com")).toBe(
    false
  );
  db.update(agentMailboxes).set({ status: "disabled" }).run();
  expect(await agent.isActiveAddress(SYSTEM_PRINCIPAL, "a@example.com")).toBe(
    false
  );
  await expect(agent.isActiveAddress(run, "a@example.com")).rejects.toThrow();
});
