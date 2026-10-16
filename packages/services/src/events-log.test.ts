import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const NOW = "2026-01-01T00:00:00.000Z";

const userPrincipal = (userId: string, workspaceId = WORKSPACE): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const alice = userPrincipal("alice");
const bob = userPrincipal("bob");

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createEventsService>;
let counter = 0;

/** Inserts an event row directly, so a test sets its time and id. */
const insertEvent = (
  fields: Partial<typeof events.$inferInsert> & { createdAt: string }
) => {
  counter += 1;
  db.insert(events)
    .values({
      actorId: "alice",
      actorKind: "user",
      id: `e${String(counter).padStart(4, "0")}`,
      payload: "{}",
      type: "run.queued",
      workspaceId: WORKSPACE,
      ...fields,
    })
    .run();
};

beforeEach(() => {
  counter = 0;
  db = migrated();
  for (const id of [WORKSPACE, "w2"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  for (const id of ["a1", "a2"]) {
    db.insert(agents)
      .values({
        createdAt: NOW,
        createdBy: "alice",
        id,
        instructions: "",
        model: "m",
        name: id,
        runtime: "fake",
        runtimeConfig: "{}",
        slug: id,
        status: "active",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const session = (
    id: string,
    origin: string,
    actorId: string,
    isPrivate = false
  ) => ({
    actorId,
    actorKind: "user",
    agentId: "a1",
    createdAt: NOW,
    id,
    origin,
    private: isPrivate,
    workspaceId: WORKSPACE,
  });
  db.insert(sessions)
    .values([
      session("s_alice_ui", "ui", "alice"),
      session("s_bob_ui", "ui", "bob"),
      session("s_bob_dm", "slack", "bob", true),
      session("s_shared", "routine", "bob"),
    ])
    .run();
  service = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
});

test("list leaves out events of another user's private sessions", async () => {
  insertEvent({ createdAt: NOW, sessionId: "s_alice_ui" });
  insertEvent({ createdAt: NOW, sessionId: "s_bob_ui" });
  insertEvent({ createdAt: NOW, sessionId: "s_bob_dm" });
  insertEvent({ createdAt: NOW, sessionId: "s_shared" });
  insertEvent({ createdAt: NOW, type: "agent.created" });

  const forAlice = await service.list(alice);
  expect(forAlice.entries.map((entry) => entry.sessionId).sort()).toEqual([
    null,
    "s_alice_ui",
    "s_shared",
  ]);
  const forBob = await service.list(bob);
  expect(forBob.entries.map((entry) => entry.sessionId).sort()).toEqual([
    null,
    "s_bob_dm",
    "s_bob_ui",
    "s_shared",
  ]);
});

test("list returns only the caller's workspace and refuses other principals", async () => {
  insertEvent({ createdAt: NOW });
  expect((await service.list(userPrincipal("alice", "w2"))).entries).toEqual(
    []
  );
  await expect(
    service.list({ kind: "machine", machineId: "m1", workspaceId: WORKSPACE })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("list pages newest first and says whether more follow", async () => {
  for (let i = 0; i < 5; i += 1) {
    insertEvent({ createdAt: NOW });
  }
  const first = await service.list(alice, { limit: 2 });
  expect(first.entries.map((entry) => entry.id)).toEqual(["e0005", "e0004"]);
  expect(first.hasMore).toBe(true);
  const second = await service.list(alice, { limit: 2, page: 1 });
  expect(second.entries.map((entry) => entry.id)).toEqual(["e0003", "e0002"]);
  expect(second.hasMore).toBe(true);
  const third = await service.list(alice, { limit: 2, page: 2 });
  expect(third.entries.map((entry) => entry.id)).toEqual(["e0001"]);
  expect(third.hasMore).toBe(false);
});

test("list filters by date range, from inclusive and to exclusive", async () => {
  insertEvent({ createdAt: "2026-02-01T23:59:59.999Z" });
  insertEvent({ createdAt: "2026-02-02T00:00:00.000Z" });
  insertEvent({ createdAt: "2026-02-02T12:00:00.000Z" });
  insertEvent({ createdAt: "2026-02-03T00:00:00.000Z" });
  const day = await service.list(alice, {
    from: "2026-02-02T00:00:00.000Z",
    to: "2026-02-03T00:00:00.000Z",
  });
  expect(day.entries.map((entry) => entry.id)).toEqual(["e0003", "e0002"]);
  const since = await service.list(alice, { from: "2026-02-03T00:00:00.000Z" });
  expect(since.entries.map((entry) => entry.id)).toEqual(["e0004"]);
  const until = await service.list(alice, { to: "2026-02-02T00:00:00.000Z" });
  expect(until.entries.map((entry) => entry.id)).toEqual(["e0001"]);
});

test("list filters by agent and event type", async () => {
  insertEvent({ agentId: "a1", createdAt: NOW, type: "run.queued" });
  insertEvent({ agentId: "a2", createdAt: NOW, type: "run.queued" });
  insertEvent({ agentId: "a2", createdAt: NOW, type: "run.failed" });
  const byAgent = await service.list(alice, { agentId: "a2" });
  expect(byAgent.entries.map((entry) => entry.id)).toEqual(["e0003", "e0002"]);
  const byType = await service.list(alice, { types: ["run.failed"] });
  expect(byType.entries.map((entry) => entry.id)).toEqual(["e0003"]);
  const both = await service.list(alice, {
    agentId: "a1",
    types: ["run.failed"],
  });
  expect(both.entries).toEqual([]);
});

test("list gives a short summary of the payload and not the payload", async () => {
  insertEvent({
    createdAt: NOW,
    payload: JSON.stringify({ error: "boom", secretish: "kept off the wire" }),
    type: "run.failed",
  });
  const [entry] = (await service.list(alice)).entries;
  expect(entry?.summary).toBe("boom");
  expect(entry).not.toHaveProperty("payload");
});
