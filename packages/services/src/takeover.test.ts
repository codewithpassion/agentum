import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  APPROVAL_TTL_MS,
  QUESTION_TTL_MS,
  TAKEOVER_TTL_MS,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";

import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";

import { createEventsService } from "./events.ts";
import type { RequestRecord } from "./requests.ts";
import { createRequestsService } from "./requests.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { createTakeoverService } from "./takeover.ts";
import { SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
let db: ReturnType<typeof migrated>;
let now: number;
let resumed: RequestRecord[];
let requests: ReturnType<typeof createRequestsService>;
let runs: ReturnType<typeof createRunsService>;
let agentId: string;
let opened: string[];
let events: ReturnType<typeof createEventsService>;

beforeEach(async () => {
  db = migrated();
  now = Date.parse("2026-10-26T00:00:00Z");
  resumed = [];
  opened = [];
  await db.insert(workspaces).values({
    clerkOrgId: "org1",
    createdAt: new Date(now).toISOString(),
    id: "w1",
    name: "Test",
    timezone: "UTC",
  });
  const clock = {
    now: () => new Date(now),
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  events = createEventsService({ blobs, db });
  events.onAppend((event) => {
    opened.push(event.type);
    return Promise.resolve();
  });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: (_run, request) => {
      resumed.push(request);
      return Promise.resolve();
    },
  };
  runs = createRunsService({
    adapters: [adapter],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  const agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, { model: "m", name: "Cloud", runtime: "cloud" })
  ).id;
  requests = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs,
    secrets: {
      maskerFor: () =>
        Promise.resolve(createMasker({ NAME: "granted-value-123" })),
    },
  });
});

const start = async () => {
  const run = await runs.startRun(user, {
    agentId,
    input: { text: "go" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, run.runId);
  return run.runId;
};

const attachComputer = async () => {
  await db.insert(machines).values({
    capabilities: "{}",
    createdAt: new Date(now).toISOString(),
    credentialHash: "hash",
    enrolledBy: "u1",
    id: "computer",
    name: "Computer",
    singleUser: false,
    status: "online",
    workspaceId: "w1",
  });
  await db
    .update(agentRows)
    .set({ computerMachineId: "computer" })
    .where(eq(agentRows.id, agentId));
};
const open = (runId: string, toolUseId = "takeover") =>
  requests.open(system, {
    kind: "takeover",
    reason: "Log in granted-value-123",
    runId,
    toolUseId,
  });
const service = (lease?: {
  take: (machineId: string, userId: string) => Promise<void>;
  release: (machineId: string) => Promise<void>;
}) => createTakeoverService({ db, events, lease, requests });

test("takeover requires a computer, waits, scrubs reason, and refuses another pending request", async () => {
  const runId = await start();
  await expect(open(runId)).rejects.toMatchObject({ code: "conflict" });
  await attachComputer();
  const request = await open(runId);
  expect(request.display).toEqual({
    machineId: "computer",
    reason: "Log in [secret:NAME]",
  });
  expect(request.toolName).toBe("request_human_takeover");
  expect(request.toolKey).toBeNull();
  expect(Date.parse(request.expiresAt) - now).toBe(TAKEOVER_TTL_MS);
  expect(
    (await db.select().from(runRows).where(eq(runRows.id, runId)))[0]?.status
  ).toBe("waiting");
  expect(await open(runId)).toEqual(request);
  await expect(open(runId, "second")).rejects.toMatchObject({
    code: "conflict",
  });
  expect(opened).toContain("computer.takeover_requested");
});

test("take and first hand-back call the lease and events; resume carries the raw note", async () => {
  await attachComputer();
  const request = await open(await start());
  const calls: unknown[] = [];
  const takeover = service({
    release: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    take: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
  });
  await takeover.take(user, request.id);
  const results = await Promise.allSettled([
    takeover.handBack(user, request.id, "done granted-value-123"),
    takeover.handBack(user, request.id, "done granted-value-123"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "conflict", message: "Already answered" },
  });
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.outcome).toEqual({
    answer: { note: "done granted-value-123" },
    status: "answered",
  });
  expect(calls).toEqual([["computer", "u1"], ["computer"]]);
  const computerEvents = (
    await events.query(user, "w1", { runId: request.runId })
  ).filter((event) => event.type.startsWith("computer."));
  expect(computerEvents.map((event) => event.type)).toEqual([
    "computer.takeover_requested",
    "computer.taken",
    "computer.handed_back",
  ]);
  expect(computerEvents[1]?.actor).toEqual({ id: "u1", kind: "user" });
  expect(computerEvents[2]?.payload.note).toBe("done [secret:NAME]");
  await expect(takeover.take(user, request.id)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("cancel resumes the cancelled outcome and releases the lease once", async () => {
  await attachComputer();
  const request = await open(await start());
  const calls: string[] = [];
  const takeover = service({
    release: (id) => {
      calls.push(id);
      return Promise.resolve();
    },
    take: () => Promise.resolve(),
  });
  await takeover.cancel(user, request.id);
  expect(resumed[0]?.outcome).toEqual({ status: "cancelled" });
  expect(calls).toEqual(["computer"]);
  expect(opened).toContain("request.cancelled");
  await expect(takeover.cancel(user, request.id)).rejects.toMatchObject({
    message: "Already answered",
  });
});

test("expiry resumes a takeover with the expired outcome", async () => {
  await attachComputer();
  await open(await start());
  now += TAKEOVER_TTL_MS;
  await requests.expireDue(system);
  expect(resumed[0]?.outcome).toEqual({ status: "expired" });
});

test("takeover methods require a visible takeover and user principal", async () => {
  await attachComputer();
  const request = await open(await start());
  const takeover = service();
  for (const principal of [
    { ...user, userId: "other" },
    { ...user, workspaceId: "other" },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: checking each isolated principal
    await expect(takeover.take(principal, request.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      takeover.handBack(principal, request.id)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(takeover.cancel(principal, request.id)).rejects.toMatchObject({
      code: "not_found",
    });
  }
  await expect(takeover.take(system, request.id)).rejects.toMatchObject({
    code: "forbidden",
  });
});

test("concurrent opens for the same computer admit only one", async () => {
  await attachComputer();
  const runId = await start();
  const results = await Promise.allSettled([
    open(runId, "first"),
    open(runId, "second"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "conflict" },
  });
});

test("a refused take logs no computer.taken event", async () => {
  await attachComputer();
  const request = await open(await start());
  const takeover = service({
    release: () => Promise.resolve(),
    take: () => Promise.reject(new Error("lease refused")),
  });
  await expect(takeover.take(user, request.id)).rejects.toThrow(
    "lease refused"
  );
  const taken = (
    await events.query(user, "w1", { runId: request.runId })
  ).filter((event) => event.type === "computer.taken");
  expect(taken).toEqual([]);
});

test("an expired takeover releases the lease", async () => {
  await attachComputer();
  await open(await start());
  const calls: string[] = [];
  const takeover = service({
    release: (id) => {
      calls.push(id);
      return Promise.resolve();
    },
    take: () => Promise.resolve(),
  });
  events.onAppend(takeover.onEvent);
  now += TAKEOVER_TTL_MS;
  await requests.expireDue(system);
  expect(calls).toEqual(["computer"]);
});

test("a takeover pending when its run ends is cancelled and releases the lease once", async () => {
  await attachComputer();
  const runId = await start();
  await open(runId);
  const calls: string[] = [];
  const takeover = service({
    release: (id) => {
      calls.push(id);
      return Promise.resolve();
    },
    take: () => Promise.resolve(),
  });
  events.onAppend(takeover.onEvent);
  await runs.cancelRun(user, runId);
  expect(opened).toContain("request.cancelled");
  expect(calls).toEqual(["computer"]);
});

test("an expired approval does not release the lease", async () => {
  await attachComputer();
  const runId = await start();
  await requests.open(system, {
    input: { command: "ls" },
    kind: "approval",
    runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "approval",
  });
  const calls: string[] = [];
  events.onAppend(
    service({
      release: (id) => {
        calls.push(id);
        return Promise.resolve();
      },
      take: () => Promise.resolve(),
    }).onEvent
  );
  now += APPROVAL_TTL_MS;
  await requests.expireDue(system);
  expect(opened).toContain("request.expired");
  expect(calls).toEqual([]);
});

test("an expired question does not release the lease", async () => {
  await attachComputer();
  const runId = await start();
  await requests.open(system, {
    kind: "question",
    questions: [{ question: "Which?" }],
    runId,
    toolName: "ask_user",
    toolUseId: "question",
  });
  const calls: string[] = [];
  events.onAppend(
    service({
      release: (id) => {
        calls.push(id);
        return Promise.resolve();
      },
      take: () => Promise.resolve(),
    }).onEvent
  );
  now += QUESTION_TTL_MS;
  await requests.expireDue(system);
  expect(opened).toContain("request.expired");
  expect(calls).toEqual([]);
});
