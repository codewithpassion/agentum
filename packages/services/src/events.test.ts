import { beforeEach, expect, test } from "bun:test";
import { events } from "@repo/db/schema/events";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "./events.ts";
import { importRunTokenKey, signRunToken } from "./run-tokens.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const principal: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const KB = 1024;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let db: ReturnType<typeof migrated>;
let store: Map<string, string>;
let service: ReturnType<typeof createEventsService>;

const base = {
  actor: { id: "u1", kind: "user" },
  workspaceId: WORKSPACE,
} as const;

beforeEach(() => {
  db = migrated();
  store = new Map();
  service = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
});

test("a small payload stays in the row", async () => {
  const event = await service.append({
    ...base,
    payload: { text: "hi" },
    sessionId: "s1",
    type: "message.user",
  });
  expect(event.id).toMatch(ULID);
  expect(event.payload).toEqual({ text: "hi" });
  expect(event.payloadRef).toBeNull();
  expect(store.size).toBe(0);
  const [row] = db.select().from(events).all();
  expect(row?.payload).toBe('{"text":"hi"}');
  expect(row?.payloadRef).toBeNull();
  expect(row?.actorKind).toBe("user");
});

test("a 100 KB payload goes to the blob store and the row keeps a ref", async () => {
  const payload = { text: "x".repeat(100 * KB) };
  const event = await service.append({
    ...base,
    payload,
    sessionId: "s1",
    type: "tool.result",
  });
  expect(store.size).toBe(1);
  const [row] = db.select().from(events).all();
  expect(row?.payload).toBe("{}");
  expect(row?.payloadRef).toBe(`payloads/${WORKSPACE}/${event.id}.json`);
  expect(store.get(row?.payloadRef ?? "")).toBe(JSON.stringify(payload));
  expect(event.payload).toEqual({});
  expect(await service.readPayload(principal, event)).toEqual(payload);
});

test("readPayload fails when the blob is gone", async () => {
  const event = await service.append({
    ...base,
    payload: { text: "x".repeat(100 * KB) },
    type: "tool.result",
  });
  store.clear();
  await expect(service.readPayload(principal, event)).rejects.toThrow(
    "missing"
  );
});

test("secrets are stripped from inline payloads", async () => {
  const event = await service.append({
    ...base,
    payload: {
      headers: { Authorization: "Bearer abc" },
      note: "keep",
      token: "hm_run_abcdefghijklmnop",
    },
    type: "connector.call",
  });
  const expected = {
    headers: { Authorization: "[redacted]" },
    note: "keep",
    token: "[redacted]",
  };
  expect(event.payload).toEqual(expected);
  expect(JSON.parse(db.select().from(events).get()?.payload ?? "")).toEqual(
    expected
  );
});

test("secrets are stripped from payloads that go to the blob store", async () => {
  await service.append({
    ...base,
    payload: { password: "hunter2", text: "x".repeat(100 * KB) },
    type: "tool.result",
  });
  const [body] = [...store.values()];
  expect(body).toContain('"password":"[redacted]"');
  expect(body).not.toContain("hunter2");
});

test("invalid input is rejected and nothing is written", async () => {
  await expect(
    service.append({ ...base, type: "nope" as never })
  ).rejects.toThrow();
  await expect(
    service.append({
      ...base,
      payload: { constructor: 1 },
      type: "run.queued",
    })
  ).rejects.toThrow();
  expect(db.select().from(events).all()).toHaveLength(0);
});

test("transcript returns messages and tool events of one session ordered by id", async () => {
  const row = (id: string, type: string, sessionId: string) => ({
    actorId: "u1",
    actorKind: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    sessionId,
    type,
    workspaceId: WORKSPACE,
  });
  // Inserted out of id order on purpose.
  db.insert(events)
    .values([
      row("03", "tool.result", "s1"),
      row("01", "message.user", "s1"),
      row("02", "tool.call", "s1"),
      row("04", "run.finished", "s1"),
      row("05", "message.user", "s2"),
      row("06", "message.assistant", "s1"),
    ])
    .run();
  const transcript = await service.transcript(principal, WORKSPACE, "s1");
  expect(transcript.map((e) => e.id)).toEqual(["01", "02", "03", "06"]);
});

test("query scopes to the workspace and applies filters", async () => {
  const a = await service.append({ ...base, runId: "r1", type: "run.queued" });
  const b = await service.append({
    ...base,
    agentId: "a1",
    runId: "r1",
    type: "run.started",
  });
  await service.append({
    ...base,
    type: "run.queued",
    workspaceId: "w2",
  });
  const c = await service.append({ ...base, runId: "r2", type: "run.failed" });

  const ids = async (filters?: Parameters<typeof service.query>[2]) =>
    (await service.query(principal, WORKSPACE, filters)).map((e) => e.id);

  expect(await ids()).toEqual([a.id, b.id, c.id]);
  expect(await ids({ runId: "r1" })).toEqual([a.id, b.id]);
  expect(await ids({ agentId: "a1" })).toEqual([b.id]);
  expect(await ids({ types: ["run.queued", "run.failed"] })).toEqual([
    a.id,
    c.id,
  ]);
  expect(await ids({ after: a.id })).toEqual([b.id, c.id]);
  expect(await ids({ limit: 2 })).toEqual([a.id, b.id]);
  await expect(
    service.query(principal, WORKSPACE, { limit: 0 })
  ).rejects.toThrow();
});

test("ids from concurrent appends sort in call order", async () => {
  const appended = await Promise.all(
    Array.from({ length: 20 }, () =>
      service.append({ ...base, type: "run.queued" })
    )
  );
  const queried = await service.query(principal, WORKSPACE);
  expect(queried.map((e) => e.id)).toEqual(appended.map((e) => e.id));
});

test("a run token under a non-secret key is redacted", async () => {
  const key = await importRunTokenKey(
    Buffer.from(new Uint8Array(32).fill(1)).toString("base64")
  );
  const output = await signRunToken(key, {
    agentId: "a1",
    issuedAt: 1_700_000_000_000,
    runId: "r1",
    workspaceId: WORKSPACE,
  });
  await service.append({
    ...base,
    payload: { output },
    type: "message.assistant",
  });
  const [row] = db.select().from(events).all();
  expect(JSON.parse(row?.payload ?? "null")).toEqual({ output: "[redacted]" });
});
