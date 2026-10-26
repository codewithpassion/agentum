import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createCloudRuntime } from "./cloud/runtime.ts";
import { createEventsService } from "./events.ts";
import { createManagedRuntime } from "./managed/runtime.ts";
import { createRequestsService } from "./requests.ts";
import { loadRun } from "./runs/queries.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
let db: ReturnType<typeof migrated>;
let now: number;
let resumed: string[];
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
      resumed.push(request.id);
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
const open = (runId: string, toolUseId = "call1") =>
  requests.open(system, {
    input: { command: "echo sk-12345678901234567890 granted-value-123" },
    kind: "approval",
    runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId,
  });
const answer = (requestId: string) =>
  requests.answer(user, {
    answer: { decision: "allow_once" },
    requestId,
    via: "web",
  });
const status = async (id: string) =>
  (await db.select().from(runRows).where(eq(runRows.id, id)))[0]?.status;

test("open is idempotent, redacts display and announces waiting once", async () => {
  const runId = await start();
  const first = await open(runId);
  expect(await open(runId)).toEqual(first);
  expect(JSON.stringify(first.display)).toContain("[redacted]");
  expect(JSON.stringify(first.display)).toContain("[secret:NAME]");
  expect(await status(runId)).toBe("waiting");
  expect(opened.filter((type) => type === "request.opened")).toHaveLength(1);
  await answer(first.id);
  expect((await open(runId)).outcome?.status).toBe("answered");
});

test("the same tool use in two runs stays separate", async () => {
  const first = await open(await start());
  // A second queued run can be forced running here to model another runtime execution.
  const second = await runs.startRun(user, {
    agentId,
    input: { text: "go" },
    session: { origin: "ui" },
  });
  await db
    .update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, second.runId));
  expect((await open(second.runId)).id).not.toBe(first.id);
});

test("the first surface wins, always allow changes the rule, and wake happens once", async () => {
  const runId = await start();
  await requests.setRule(user, { agentId, mode: "ask", toolKey: "bash" });
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(
    true
  );
  const request = await open(runId);
  await requests.answer(user, {
    answer: { decision: "always_allow" },
    requestId: request.id,
    via: "slack",
  });
  await expect(answer(request.id)).rejects.toMatchObject({
    code: "conflict",
    message: "Already answered",
  });
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(
    false
  );
  expect(resumed).toEqual([request.id]);
});

test("two pending requests keep waiting until both close", async () => {
  const runId = await start();
  const first = await open(runId);
  const second = await open(runId, "call2");
  await answer(first.id);
  expect(await status(runId)).toBe("waiting");
  await answer(second.id);
  expect(await status(runId)).toBe("running");
  expect(resumed).toEqual([first.id, second.id]);
});

test("expiry resumes once, cancellation closes requests, and hidden sessions are not found", async () => {
  const runId = await start();
  const request = await open(runId);
  const other = { ...user, userId: "other" };
  await expect(
    requests.answer(other, {
      answer: { decision: "deny" },
      requestId: request.id,
      via: "web",
    })
  ).rejects.toMatchObject({ code: "not_found" });
  now += 60 * 60_000 + 1;
  await requests.expireDue(system);
  await requests.expireDue(system);
  expect(await requests.outcome(system, request.id)).toEqual({
    status: "expired",
  });
  expect(await status(runId)).toBe("running");
  expect(resumed).toEqual([request.id]);
  const next = await open(runId, "call2");
  await runs.cancelRun(user, runId);
  expect(await requests.outcome(system, next.id)).toEqual({
    status: "cancelled",
  });
});

test("question answers are scrubbed, polling is capped, and only the claimer can open", async () => {
  const runId = await start();
  await expect(
    requests.open(user, {
      kind: "question",
      questions: [{ question: "Which?" }],
      runId,
      toolName: "ask_user",
      toolUseId: "q",
    })
  ).rejects.toThrow();
  const request = await requests.open(system, {
    kind: "question",
    questions: [{ question: "Which?" }],
    runId,
    toolName: "ask_user",
    toolUseId: "q",
  });
  const before = now;
  expect(
    await requests.waitForOutcome(system, request.id, { waitMs: 30_000 })
  ).toBeNull();
  expect(now - before).toBe(25_000);
  await requests.answer(user, {
    answer: { answers: { "Which?": "sk-12345678901234567890" } },
    requestId: request.id,
    via: "web",
  });
  expect(JSON.stringify(await requests.outcome(system, request.id))).toContain(
    "[redacted]"
  );
});

test("simultaneous opens and answers have one winner", async () => {
  const runId = await start();
  const [first, second] = await Promise.all([open(runId), open(runId)]);
  expect(first.id).toBe(second.id);
  expect(opened.filter((type) => type === "request.opened")).toHaveLength(1);
  const results = await Promise.allSettled([
    answer(first.id),
    requests.answer(user, {
      answer: { decision: "deny" },
      requestId: first.id,
      via: "slack",
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(resumed).toEqual([first.id]);
});

test("pending and rules lists respect visibility and rule removal defaults to allow", async () => {
  const runId = await start();
  const request = await open(runId);
  expect(
    (await requests.listPending(user, { sessionId: request.sessionId })).map(
      (row) => row.id
    )
  ).toEqual([request.id]);
  expect(await requests.listPending({ ...user, userId: "other" }, {})).toEqual(
    []
  );
  await requests.setRule(user, { agentId, mode: "ask", toolKey: "bash" });
  await requests.setRule(user, { agentId, mode: "allow", toolKey: "bash" });
  expect(await requests.listRules(user, { agentId })).toMatchObject([
    { mode: "allow", toolKey: "bash" },
  ]);
  await requests.removeRule(user, { agentId, toolKey: "bash" });
  expect(await requests.listRules(user, { agentId })).toEqual([]);
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(
    false
  );
  expect(opened.filter((type) => type === "tool_rule.changed")).toHaveLength(3);
});

test("oversized approval input is capped after scrubbing", async () => {
  const request = await requests.open(system, {
    input: { command: `sk-12345678901234567890 ${"😀".repeat(5000)}` },
    kind: "approval",
    runId: await start(),
    toolName: "bash",
    toolUseId: "large",
  });
  expect("input" in request.display).toBe(true);
  if ("input" in request.display) {
    expect(
      new TextEncoder().encode(JSON.stringify(request.display.input)).length
    ).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(request.display.input)).toContain("[redacted]");
  }
});

for (const terminalStatus of ["done", "failed", "aborted"] as const) {
  test(`run completion ${terminalStatus} cancels pending requests without resuming`, async () => {
    const runId = await start();
    const request = await open(runId);
    await runs.completeRun(system, runId, { status: terminalStatus });
    expect(await requests.outcome(system, request.id)).toEqual({
      status: "cancelled",
    });
    expect(resumed).toEqual([]);
    await requests.expireDue(system);
    expect(opened.filter((type) => type === "request.cancelled")).toHaveLength(
      1
    );
  });
}

test("cloud and managed resume forward a closed request to their wake-up ports", async () => {
  const runId = await start();
  const request = await open(runId);
  const run = await loadRun(db, runId);
  if (!run) {
    throw new Error("Missing run");
  }
  const cloudCalls: string[][] = [];
  const managedCalls: string[] = [];
  const cloud = createCloudRuntime({
    platformUrl: "https://example.test",
    runner: {
      answered: (...ids) => {
        cloudCalls.push(ids);
        return Promise.resolve();
      },
      cancel: () => Promise.resolve(),
      start: () => Promise.resolve(),
    },
    runTokenKey: "unused",
  });
  const managed = createManagedRuntime({
    abandon: () => Promise.resolve(),
    poller: {
      cancel: () => Promise.resolve(),
      kick: (id) => {
        managedCalls.push(id);
        return Promise.resolve();
      },
    },
  });
  await cloud.resume?.(run, request);
  await managed.resume?.(run, request);
  expect(cloudCalls).toEqual([[run.id, run.sessionId, request.id]]);
  expect(managedCalls).toEqual([run.id]);
  const legacy = createCloudRuntime({
    platformUrl: "https://example.test",
    runner: { cancel: () => Promise.resolve(), start: () => Promise.resolve() },
    runTokenKey: "unused",
  });
  await legacy.resume?.(run, request);
});

test("an answer delivered during the opened notification leaves the run running", async () => {
  const runId = await start();
  events.onAppend(async (event) => {
    if (
      event.type === "request.opened" &&
      typeof event.payload.requestId === "string"
    ) {
      await answer(event.payload.requestId);
    }
  });
  const request = await open(runId);
  expect(await requests.outcome(system, request.id)).toMatchObject({
    status: "answered",
  });
  expect(await status(runId)).toBe("running");
  expect(resumed).toEqual([request.id]);
});

test("only the machine that claimed the run can open and poll its requests", async () => {
  const runId = await start();
  await db
    .update(runRows)
    .set({ claimedBy: "m1" })
    .where(eq(runRows.id, runId));
  const machine = {
    kind: "machine",
    machineId: "m1",
    workspaceId: "w1",
  } as const;
  const wrongMachine = { ...machine, machineId: "m2" };
  const input = {
    input: {},
    kind: "approval",
    runId,
    toolName: "bash",
    toolUseId: "machine-call",
  } as const;
  await expect(requests.open(wrongMachine, input)).rejects.toMatchObject({
    code: "forbidden",
  });
  const request = await requests.open(machine, input);
  expect(await requests.outcome(machine, request.id)).toBeNull();
  await expect(
    requests.outcome(wrongMachine, request.id)
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(requests.expireDue(user)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(
    requests.outcome({ ...user, workspaceId: "foreign" }, request.id)
  ).rejects.toMatchObject({ code: "not_found" });
});
