// biome-ignore-all lint/performance/noAwaitInLoops: Pages and filters are walked in order.
import { expect, test } from "bun:test";
import { createConversationsService } from "./conversations.ts";
import type { Principal } from "./workspaces.ts";

const user: Principal = {
  isAdmin: false,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "ws_a",
};

const at = (minute: number) =>
  `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

/** Fake sources that page like the real ones: newest first, after a cursor, capped at the limit. */
const fakeSource = <T extends { cursor: string }>(
  rows: T[],
  seen: unknown[] = []
) => ({
  list: (_principal: Principal, options: Record<string, unknown> = {}) => {
    seen.push(options);
    const after = options.cursor as string | undefined;
    const limit = (options.limit as number | undefined) ?? 50;
    return Promise.resolve(
      rows
        .filter((row) => after === undefined || row.cursor < after)
        .slice(0, limit)
    );
  },
});

const thread = (id: string, minute: number) => ({
  agentId: "a1",
  createdAt: at(0),
  cursor: `${at(minute)}~${id}`,
  id,
  lastRunAt: at(minute),
  title: `Thread ${id}`,
});
const conversation = (id: string, minute: number) => ({
  cursor: `${at(minute)}~${id}`,
  id,
  title: `Chat ${id}`,
  updatedAt: at(minute),
});

const build = (
  threads: ReturnType<typeof thread>[],
  chats: ReturnType<typeof conversation>[]
) => {
  const threadCalls: unknown[] = [];
  const chatCalls: unknown[] = [];
  const service = createConversationsService({
    assistant: fakeSource(chats, chatCalls) as never,
    sessions: fakeSource(threads, threadCalls) as never,
  });
  return { chatCalls, service, threadCalls };
};

test("threads and assistant conversations share one list, newest first, each marked with its kind", async () => {
  const { service } = build(
    [thread("t1", 5), thread("t2", 1)],
    [conversation("c1", 3)]
  );
  const rows = await service.list(user);
  expect(rows.map((row) => [row.kind, row.id])).toEqual([
    ["thread", "t1"],
    ["assistant", "c1"],
    ["thread", "t2"],
  ]);
  expect(rows[1]?.title).toBe("Chat c1");
  expect(rows[0]?.activityAt).toBe(at(5));
});

test("paging with the last row's cursor walks both sources without repeats or gaps", async () => {
  const threads = [10, 8, 6, 4, 2].map((minute) =>
    thread(`t${minute}`, minute)
  );
  const chats = [9, 7, 5, 3, 1].map((minute) =>
    conversation(`c${minute}`, minute)
  );
  const { service } = build(threads, chats);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const rows = await service.list(user, { cursor, limit: 3 });
    seen.push(...rows.map((row) => row.id));
    cursor = rows.at(-1)?.cursor;
    if (rows.length === 0) {
      break;
    }
  }
  expect(seen).toEqual([
    "t10",
    "c9",
    "t8",
    "c7",
    "t6",
    "c5",
    "t4",
    "c3",
    "t2",
    "c1",
  ]);
});

test("an agent, origin or working filter leaves assistant conversations out", async () => {
  for (const filter of [
    { agentId: "a1" },
    { origin: "ui" as const },
    { working: true },
  ]) {
    const { chatCalls, service } = build(
      [thread("t1", 5)],
      [conversation("c1", 3)]
    );
    const rows = await service.list(user, filter);
    expect(rows.map((row) => row.kind)).toEqual(["thread"]);
    expect(chatCalls).toEqual([]);
  }
});

test("the query reaches both sources, and a non-session principal sees threads only", async () => {
  const { chatCalls, service, threadCalls } = build(
    [thread("t1", 5)],
    [conversation("c1", 3)]
  );
  await service.list(user, { query: "acme" });
  expect(chatCalls).toMatchObject([{ query: "acme" }]);
  expect(threadCalls).toMatchObject([{ query: "acme" }]);
  const other = build([thread("t1", 5)], [conversation("c1", 3)]);
  const keyed: Principal = { ...user, via: "api_key" } as Principal;
  expect((await other.service.list(keyed)).map((row) => row.kind)).toEqual([
    "thread",
  ]);
});

test("a bad cursor is refused", async () => {
  const { service } = build([], []);
  await expect(service.list(user, { cursor: "nope" })).rejects.toThrow();
});
