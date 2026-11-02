import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const servicesFor = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("a post that mentions the fake agent gets its reply in the thread", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
    slug: "pelican",
  });
  const thread = await caller.inbox.createThread({ title: "Hello" });

  const { runs } = await caller.inbox.post({
    text: "@pelican hi",
    threadId: thread.id,
  });

  const view = await caller.inbox.readThread({ threadId: thread.id });
  // The fake agent echoes its whole wake input, which names the thread.
  expect(view.posts.map((post) => [post.authorKind, post.text])).toEqual([
    ["user", "@pelican hi"],
    ["agent", expect.stringContaining("Echo: @pelican hi\n")],
  ]);
  expect(view.posts[1]?.text).toContain(thread.id);
  expect(view.posts[1]?.runId).toBe(runs[0]?.runId);
  const listed = await caller.inbox.listThreads();
  expect(listed.map((item) => item.id)).toEqual([thread.id]);
});

test("another workspace cannot see the thread", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  const thread = await owner.inbox.createThread({ title: "Private" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });

  await expect(
    other.inbox.readThread({ threadId: thread.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await other.inbox.listThreads()).toEqual([]);
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.inbox.listThreads()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("dismissing a thread needs a workspace session, and the thread must be in it", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  const thread = await owner.inbox.createThread({ title: "Plans" });

  const dismissed = await owner.inbox.clearAttention({ threadId: thread.id });
  expect(dismissed.attentionClearedAt).not.toBeNull();

  const signedOut = await callerFor({ orgId: "org_a", userId: null });
  await expect(
    signedOut.inbox.clearAttention({ threadId: thread.id })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });
  await expect(
    other.inbox.clearAttention({ threadId: thread.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
