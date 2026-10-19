import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import type { PersonName } from "./events/summary.ts";
import { createEventsService, type PeopleLookup } from "./events.ts";
import { createRunsService } from "./runs.ts";
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

test("list gives each entry the status of its run, null without a run", async () => {
  db.insert(runs)
    .values({
      actorId: "alice",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "r_live",
      inputText: "hi",
      sessionId: "s_alice_ui",
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
  insertEvent({ createdAt: NOW, runId: "r_live", type: "run.started" });
  insertEvent({ createdAt: NOW, type: "agent.created" });

  const [withoutRun, withRun] = (await service.list(alice)).entries;
  expect(withRun).toMatchObject({ runId: "r_live", runStatus: "running" });
  expect(withoutRun).toMatchObject({ runId: null, runStatus: null });
});

test("list shows the run as cancelled after cancelRun, and who cancelled it", async () => {
  db.insert(runs)
    .values({
      actorId: "alice",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "r_cancel",
      inputText: "hi",
      sessionId: "s_alice_ui",
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
  insertEvent({ createdAt: NOW, runId: "r_cancel", type: "run.started" });
  const runsService = createRunsService({
    adapters: [],
    atomic: sqliteAtomic(db),
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    clock: { now: () => new Date(NOW), sleep: () => Promise.resolve() },
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  await runsService.cancelRun(alice, "r_cancel");

  const page = await service.list(alice);
  expect(
    page.entries.find((entry) => entry.runId === "r_cancel")
  ).toMatchObject({ runStatus: "cancelled" });
  expect(
    page.entries.find((entry) => entry.type === "run.cancelled")?.summary
  ).toBe("Cancelled by user alice");
});

const serviceWith = (people?: PeopleLookup) =>
  createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
    people,
  });

/** A people lookup that answers from `names` and records the ids it was asked for. */
const recordingPeople = (names: Map<string, PersonName>) => {
  const calls: string[][] = [];
  const lookup: PeopleLookup = (userIds) => {
    calls.push([...userIds]);
    return Promise.resolve(names);
  };
  return { calls, lookup };
};

test("list names the user who cancelled, by name", async () => {
  insertEvent({
    actorId: "user_1",
    createdAt: NOW,
    type: "run.cancelled",
  });
  const { lookup } = recordingPeople(
    new Map([["user_1", { email: "dom@example.com", name: "Dom Fretz" }]])
  );
  const [entry] = (await serviceWith(lookup).list(alice)).entries;
  expect(entry?.summary).toBe("Cancelled by Dom Fretz");
  expect(entry?.actor).toEqual({ id: "user_1", kind: "user" });
});

test("list names the user by email when they have no name", async () => {
  insertEvent({ actorId: "user_1", createdAt: NOW, type: "run.cancelled" });
  const { lookup } = recordingPeople(
    new Map([["user_1", { email: "dom@example.com", name: null }]])
  );
  const [entry] = (await serviceWith(lookup).list(alice)).entries;
  expect(entry?.summary).toBe("Cancelled by dom@example.com");
});

test("list falls back to the user id when the person is not found", async () => {
  insertEvent({ actorId: "user_1", createdAt: NOW, type: "run.cancelled" });
  const { lookup } = recordingPeople(new Map());
  const [entry] = (await serviceWith(lookup).list(alice)).entries;
  expect(entry?.summary).toBe("Cancelled by user user_1");
});

test("list still loads with ids when the people lookup throws", async () => {
  insertEvent({ actorId: "user_1", createdAt: NOW, type: "run.cancelled" });
  insertEvent({ createdAt: NOW, type: "agent.created" });
  const failing: PeopleLookup = () =>
    Promise.reject(new Error("directory down"));
  const page = await serviceWith(failing).list(alice);
  expect(page.entries).toHaveLength(2);
  expect(
    page.entries.find((entry) => entry.type === "run.cancelled")?.summary
  ).toBe("Cancelled by user user_1");
});

test("list looks up each cancelling user once, and no one else", async () => {
  insertEvent({ actorId: "user_1", createdAt: NOW, type: "run.cancelled" });
  insertEvent({ actorId: "user_1", createdAt: NOW, type: "run.cancelled" });
  insertEvent({ actorId: "user_2", createdAt: NOW, type: "run.queued" });
  const { calls, lookup } = recordingPeople(new Map());
  await serviceWith(lookup).list(alice);
  expect(calls).toEqual([["user_1"]]);
});

test("list does not look anyone up without a user-cancelled event", async () => {
  insertEvent({ actorId: "user_2", createdAt: NOW, type: "run.queued" });
  insertEvent({
    actorId: "sys",
    actorKind: "system",
    createdAt: NOW,
    type: "run.cancelled",
  });
  const { calls, lookup } = recordingPeople(new Map());
  const page = await serviceWith(lookup).list(alice);
  expect(calls).toEqual([]);
  expect(page.entries.map((entry) => entry.summary).sort()).toEqual([
    "",
    "Cancelled by the system",
  ]);
});
