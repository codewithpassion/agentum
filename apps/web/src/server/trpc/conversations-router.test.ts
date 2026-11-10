import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { assistantConversations } from "@repo/db/schema/assistant";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const setup = () => {
  const db = migrated(["org_a"]);
  const store = new Map<string, string>();
  const composed = composeWith({
    db,
    infra: {
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
    },
  });
  const caller = async (userId: string) =>
    appRouter.createCaller(
      await buildContext({
        composed,
        session: { orgId: "org_a", userId },
      })
    );
  return { caller, db };
};

test("one list holds the caller's threads and assistant conversations, marked by kind", async () => {
  const { caller, db } = setup();
  const me = await caller("user_1");
  const agent = await me.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  const started = await me.runs.start({
    agentId: agent.id,
    input: { text: "hello there" },
    session: { origin: "ui" },
  });
  const workspace = (await me.me()).workspaceId;
  db.insert(assistantConversations)
    .values({
      createdAt: "2999-01-01T00:00:00.000Z",
      id: "chat_1",
      title: "Set up a helper",
      updatedAt: "2999-01-01T00:00:00.000Z",
      userId: "user_1",
      workspaceId: workspace,
    })
    .run();

  const rows = await me.conversations.list({});
  expect(rows.map((row) => [row.kind, row.id, row.title])).toEqual([
    ["assistant", "chat_1", "Set up a helper"],
    ["thread", started.sessionId, "hello there"],
  ]);

  expect(
    (await me.conversations.list({ query: "helper" })).map((row) => row.id)
  ).toEqual(["chat_1"]);
  expect(
    (await me.conversations.list({ agentId: agent.id })).map((row) => row.id)
  ).toEqual([started.sessionId]);

  // Another member sees neither the thread nor the assistant conversation.
  const other = await caller("user_2");
  expect(await other.conversations.list({})).toEqual([]);
});
