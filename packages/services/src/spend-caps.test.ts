import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { dreamRuns } from "@repo/db/schema/dreams";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { SESSION_ORIGINS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import {
  ERROR_REASON,
  pausedMessage,
  workspaceLimitMessage,
} from "./errors.ts";
import { createEventsService } from "./events.ts";
import { loadRun } from "./runs/queries.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { createSpendService, type SpendService } from "./spend.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const TEAM = "t1";
const START = "2026-10-16T10:00:00.000Z";
const EARLIER = "2026-10-01T00:00:00.000Z";
const CAP_CENTS = 100;

const owner: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const admin: Principal = { ...owner, isAdmin: true, userId: "boss" };
const colleague: Principal = { ...owner, userId: "u2" };

let db: ReturnType<typeof migrated>;
let agents: AgentsService;
let runs: RunsService;
let spend: SpendService;
let aId: string;
let bId: string;

const spyAdapter = (): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: () => Promise.resolve(),
  kind: "machine",
});

const agentRow = (id: string) =>
  db.select().from(agentRows).where(eq(agentRows.id, id)).get();

const start = (agentId: string, origin: "ui" | "mcp" = "ui") =>
  runs.startRun(owner, {
    agentId,
    input: { text: "hello" },
    session: { origin },
  });

/** Starts a run for the agent and finishes it having cost `costUsd`. */
const spendOn = async (agentId: string, costUsd: number) => {
  const started = await start(agentId, "mcp");
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, started.runId))
    .run();
  await runs.completeRun(SYSTEM_PRINCIPAL, started.runId, {
    status: "done",
    usage: { costUsd },
  });
  return started;
};

const setCap = (agentId: string, weeklyCapCents: number) =>
  db
    .update(agentRows)
    .set({ weeklyCapCents })
    .where(eq(agentRows.id, agentId))
    .run();

const setWorkspaceCap = (weeklyCapCents: number) =>
  db
    .update(workspaceRows)
    .set({ weeklyCapCents })
    .where(eq(workspaceRows.id, WORKSPACE))
    .run();

/** A team dream with no agent, which costs `costUsd` and started at `startedAt`. */
const teamDream = (id: string, costUsd: number, startedAt = START) =>
  db
    .insert(dreamRuns)
    .values({
      agentId: null,
      id,
      startedAt,
      status: "done",
      teamId: TEAM,
      usage: JSON.stringify({ costUsd }),
      workspaceId: WORKSPACE,
    })
    .run();

const makeAgent = async (name: string) =>
  (
    await agents.create(owner, {
      machineId: "m1",
      model: "m",
      name,
      runtime: "machine",
    })
  ).id;

beforeEach(async () => {
  db = migrated();
  const clock: Clock = {
    now: () => new Date(START),
    sleep: () => Promise.resolve(),
  };
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  db.insert(workspaceRows)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  db.insert(teams)
    .values({
      createdAt: START,
      id: TEAM,
      name: "Team",
      slug: "team",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "h",
      enrolledBy: "u1",
      id: "m1",
      name: "m1",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();
  agents = createAgentsService({
    db,
    events: createEventsService({ blobs, db }),
  });
  aId = await makeAgent("Ada");
  bId = await makeAgent("Bo");
  spend = createSpendService({ atomic: sqliteAtomic(db), clock, db });
  runs = createRunsService({
    adapters: [spyAdapter()],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
    spend,
  });
});

test("an agent is paused when a finished run takes its week to the cap", async () => {
  setCap(aId, CAP_CENTS);
  await spendOn(aId, 0.6);
  expect(agentRow(aId)?.pausedAt).toBeNull();

  await spendOn(aId, 0.6);
  expect(agentRow(aId)).toMatchObject({
    pausedAt: START,
    pausedReason: "spend_cap",
  });
  expect(agentRow(bId)?.pausedAt).toBeNull();
});

test("a cancelled run keeps the usage its runtime reports afterwards", async () => {
  setCap(aId, CAP_CENTS);
  const started = await start(aId);
  await runs.cancelRun(owner, started.runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, started.runId, {
    status: "failed",
    usage: { costUsd: 2 },
  });
  const row = db
    .select()
    .from(runRows)
    .where(eq(runRows.id, started.runId))
    .get();
  expect(row?.status).toBe("cancelled");
  expect(JSON.parse(row?.usage ?? "{}")).toEqual({ costUsd: 2 });
  expect(agentRow(aId)?.pausedAt).not.toBeNull();
});

test("an aborted completion stores the usage it carries", async () => {
  setCap(aId, CAP_CENTS);
  const started = await start(aId, "mcp");
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, started.runId))
    .run();
  await runs.completeRun(SYSTEM_PRINCIPAL, started.runId, {
    status: "aborted",
    usage: { costUsd: 3 },
  });
  const row = db
    .select()
    .from(runRows)
    .where(eq(runRows.id, started.runId))
    .get();
  expect(row?.status).toBe("interrupted");
  expect(JSON.parse(row?.usage ?? "{}")).toEqual({ costUsd: 3 });
  expect(agentRow(aId)?.pausedAt).not.toBeNull();
});

test("an agent with no cap is never paused", async () => {
  await spendOn(aId, 50);
  expect(agentRow(aId)?.pausedAt).toBeNull();
});

test("a paused agent refuses a start from every origin with a plain message", async () => {
  setCap(aId, CAP_CENTS);
  await spendOn(aId, 2);
  const before = db.select().from(runRows).all().length;

  const refusals = await Promise.all(
    SESSION_ORIGINS.map((origin) =>
      runs
        .startRun(owner, {
          agentId: aId,
          input: { text: "hi" },
          session: { externalKey: `k-${origin}`, origin },
        })
        .then(
          () => null,
          (error: unknown) => error
        )
    )
  );
  expect(refusals).toHaveLength(SESSION_ORIGINS.length);
  for (const refused of refusals) {
    expect(refused).toMatchObject({
      code: "conflict",
      message: pausedMessage("Ada"),
      reason: ERROR_REASON.agentPaused,
    });
  }
  expect(db.select().from(runRows).all()).toHaveLength(before);
  // Another agent is not affected.
  await start(bId);
});

test("a run in flight finishes after the agent is paused", async () => {
  setCap(aId, CAP_CENTS);
  const inFlight = await start(aId);
  await spendOn(aId, 2);
  expect(agentRow(aId)?.pausedAt).toBe(START);
  expect(
    db.select().from(runRows).where(eq(runRows.id, inFlight.runId)).get()
  ).toMatchObject({ status: "queued" });

  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, inFlight.runId))
    .run();
  await runs.completeRun(SYSTEM_PRINCIPAL, inFlight.runId, { status: "done" });
  expect(
    db.select().from(runRows).where(eq(runRows.id, inFlight.runId)).get()
  ).toMatchObject({ status: "done" });
});

test("resume clears the pause, keeps or replaces the cap, and lets runs start", async () => {
  setCap(aId, CAP_CENTS);
  await spendOn(aId, 2);

  expect(await spend.resume(owner, { agentId: aId })).toEqual({
    pausedAt: null,
    pausedReason: null,
    weeklyCapCents: CAP_CENTS,
  });
  await start(aId);

  await spendOn(aId, 0.1);
  expect(agentRow(aId)?.pausedAt).toBe(START);
  expect(
    await spend.resume(admin, { agentId: aId, weeklyCapCents: 1000 })
  ).toMatchObject({ pausedAt: null, weeklyCapCents: 1000 });
  expect(agentRow(aId)).toMatchObject({ pausedAt: null, weeklyCapCents: 1000 });
  expect(
    await spend.resume(owner, { agentId: aId, weeklyCapCents: null })
  ).toMatchObject({ weeklyCapCents: null });
});

test("only the agent's owner or an org admin may resume or set a cap", async () => {
  setCap(aId, CAP_CENTS);
  await spendOn(aId, 2);

  const others = [
    colleague,
    {
      ...owner,
      apiKey: { access: "write" as const, id: "k" },
      via: "api_key" as const,
    },
    { agentId: aId, kind: "run" as const, runId: "r", workspaceId: WORKSPACE },
  ] satisfies Principal[];
  await Promise.all(
    others.flatMap((other) => [
      expect(spend.resume(other, { agentId: aId })).rejects.toBeInstanceOf(
        ForbiddenError
      ),
      expect(
        spend.setCap(other, { agentId: aId, weeklyCapCents: 5000 })
      ).rejects.toBeInstanceOf(ForbiddenError),
    ])
  );
  expect(agentRow(aId)?.pausedAt).toBe(START);
  expect(
    await spend.setCap(owner, { agentId: aId, weeklyCapCents: 5000 })
  ).toEqual({ agentId: aId, weeklyCapCents: 5000 });
  await expect(spend.resume(owner, { agentId: "nope" })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("the workspace cap pauses every agent, and only an admin sets it", async () => {
  await expect(
    spend.setCap(owner, { agentId: null, weeklyCapCents: CAP_CENTS })
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    await spend.setCap(admin, { agentId: null, weeklyCapCents: CAP_CENTS })
  ).toEqual({ agentId: null, weeklyCapCents: CAP_CENTS });

  await spendOn(aId, 0.6);
  expect(agentRow(bId)?.pausedAt).toBeNull();
  await spendOn(bId, 0.6);
  for (const id of [aId, bId]) {
    expect(agentRow(id)).toMatchObject({
      pausedAt: START,
      pausedReason: "spend_cap",
    });
  }
  expect(await spend.caps(owner)).toMatchObject({
    workspaceCapCents: CAP_CENTS,
  });
  await expect(start(bId)).rejects.toMatchObject({
    reason: ERROR_REASON.agentPaused,
  });
});

test("caps lists each agent's cap and pause", async () => {
  setCap(aId, CAP_CENTS);
  await spendOn(aId, 2);
  expect(await spend.caps(owner)).toEqual({
    agents: [
      {
        agentId: aId,
        pausedAt: START,
        pausedReason: "spend_cap",
        weeklyCapCents: CAP_CENTS,
      },
      {
        agentId: bId,
        pausedAt: null,
        pausedReason: null,
        weeklyCapCents: null,
      },
    ],
    workspaceCapCents: null,
  });
});

test("a run queued before the pause waits for the resume, unless it is a follow-up of work under way", async () => {
  setCap(aId, CAP_CENTS);
  const waiting = await start(aId);
  const followUp = await start(aId, "mcp");
  db.update(runRows)
    .set({ requestId: "question-answer:parked" })
    .where(eq(runRows.id, followUp.runId))
    .run();
  await spendOn(aId, 2);
  expect(agentRow(aId)?.pausedAt).toBe(START);

  await expect(
    runs.claimRun(SYSTEM_PRINCIPAL, waiting.runId)
  ).rejects.toMatchObject({ message: "Run cannot be claimed" });
  expect((await runs.claimRun(SYSTEM_PRINCIPAL, followUp.runId)).status).toBe(
    "running"
  );

  db.update(runRows)
    .set({ status: "done" })
    .where(eq(runRows.id, followUp.runId))
    .run();
  await spend.resume(owner, { agentId: aId, weeklyCapCents: 5000 });
  expect((await runs.claimRun(SYSTEM_PRINCIPAL, waiting.runId)).status).toBe(
    "running"
  );
});

test("a caller cannot pick a request id that looks like a follow-up", async () => {
  for (const requestId of [
    "question-answer:x",
    "handoff-wake:x",
    "Question-Answer:x",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: two calls
    await expect(
      runs.startRun(owner, {
        agentId: aId,
        input: { text: "hi" },
        requestId,
        session: { origin: "ui" },
      })
    ).rejects.toMatchObject({ code: "invalid" });
  }
});

test("a team dream counts toward the workspace cap and toward no agent's own cap", async () => {
  setWorkspaceCap(CAP_CENTS);
  teamDream("td1", 0.5);
  expect(await spend.wouldExceed(aId)).toBe(false);

  teamDream("td2", 0.5);
  expect(await spend.wouldExceed(aId)).toBe(true);
  expect(await spend.wouldExceed(bId)).toBe(true);
});

test("with only an agent cap, a team dream does not move that agent's total", async () => {
  setCap(aId, CAP_CENTS);
  teamDream("td1", 5);
  expect(await spend.weekToDate(aId)).toBe(0);
  expect(await spend.wouldExceed(aId)).toBe(false);
  expect(await spend.workspaceOver(WORKSPACE)).toBe(false);
});

test("workspaceOver sums agent and team spend to the cap, and is false with no cap", async () => {
  await spendOn(aId, 0.3);
  teamDream("td1", 0.2);
  teamDream("td-future", 99, "2026-10-16T10:00:00.001Z");
  expect(await spend.workspaceOver(WORKSPACE)).toBe(false);

  setWorkspaceCap(CAP_CENTS + 1);
  expect(await spend.workspaceOver(WORKSPACE)).toBe(false);
  setWorkspaceCap(CAP_CENTS / 2);
  expect(await spend.workspaceOver(WORKSPACE)).toBe(true);
});

test("enforceWorkspaceCap pauses every active agent once the workspace is over, and keeps a first pause", async () => {
  setWorkspaceCap(CAP_CENTS);
  db.update(agentRows)
    .set({ pausedAt: EARLIER, pausedReason: "manual" })
    .where(eq(agentRows.id, aId))
    .run();
  teamDream("td1", 1);

  await spend.enforceWorkspaceCap(WORKSPACE);
  expect(agentRow(aId)).toMatchObject({
    pausedAt: EARLIER,
    pausedReason: "manual",
  });
  expect(agentRow(bId)).toMatchObject({
    pausedAt: START,
    pausedReason: "spend_cap",
  });
});

test("enforceWorkspaceCap does nothing while the workspace is under its cap", async () => {
  setWorkspaceCap(CAP_CENTS);
  teamDream("td1", 0.5);

  await spend.enforceWorkspaceCap(WORKSPACE);
  expect(agentRow(aId)?.pausedAt).toBeNull();
  expect(agentRow(bId)?.pausedAt).toBeNull();
});

const WEEK_OVER_CAP_USD = 1.5;
const RESUME_ROUNDS = 3;

const refusedByWorkspaceLimit = (agentName: string) => ({
  code: "conflict",
  message: workspaceLimitMessage(agentName),
  reason: ERROR_REASON.agentPaused,
});

test("a member's resume does not restart an agent while the workspace is over its cap", async () => {
  setWorkspaceCap(CAP_CENTS);
  await spendOn(aId, WEEK_OVER_CAP_USD);
  expect(agentRow(aId)?.pausedAt).toBe(START);
  const before = db.select().from(runRows).all().length;

  for (let round = 0; round < RESUME_ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each resume must follow the refused start
    await spend.resume(owner, { agentId: aId });
    expect(agentRow(aId)?.pausedAt).toBeNull();
    await expect(start(aId)).rejects.toMatchObject(
      refusedByWorkspaceLimit("Ada")
    );
  }
  expect(db.select().from(runRows).all()).toHaveLength(before);
});

test("an agent made while the workspace is over its cap cannot start", async () => {
  setWorkspaceCap(CAP_CENTS);
  await spendOn(aId, WEEK_OVER_CAP_USD);
  const created = await makeAgent("Cy");
  expect(agentRow(created)?.pausedAt).toBeNull();

  await expect(start(created)).rejects.toMatchObject(
    refusedByWorkspaceLimit("Cy")
  );
});

test("a parked run's answer and a subagent still start while the workspace is over its cap", async () => {
  const parked = await start(bId, "mcp");
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, parked.runId))
    .run();
  db.update(agentRows)
    .set({ subagents: true })
    .where(eq(agentRows.id, bId))
    .run();
  setWorkspaceCap(CAP_CENTS);
  await spendOn(aId, WEEK_OVER_CAP_USD);
  await spend.resume(owner, { agentId: bId });
  await expect(start(bId)).rejects.toMatchObject(refusedByWorkspaceLimit("Bo"));

  const record = await loadRun(db, parked.runId);
  expect(record).not.toBeNull();
  const answer = await runs.startRun(
    SYSTEM_PRINCIPAL,
    {
      agentId: bId,
      input: { text: "the answer" },
      requestId: "question-answer:k",
      session: { origin: "mcp" },
    },
    { continuationOf: record ?? undefined, sessionId: record?.sessionId }
  );
  expect(answer.runId).toBeTruthy();

  const child = await runs.startRun(
    {
      agentId: bId,
      kind: "run",
      runId: parked.runId,
      workspaceId: WORKSPACE,
    },
    { agentId: bId, input: { text: "dig" }, session: { origin: "mcp" } },
    { subagent: { accessScope: {}, level: 1, model: "m" } }
  );
  expect(child.runId).toBeTruthy();
});

test("no start is refused with no workspace cap, or a cap above the week", async () => {
  await spendOn(aId, 50);
  await start(bId);

  setWorkspaceCap(10_000);
  await start(bId);
  await start(await makeAgent("Cy"));
});

test("a start looks at the workspace's week only when the workspace has a cap", async () => {
  let checks = 0;
  const counted = createRunsService({
    adapters: [spyAdapter()],
    atomic: sqliteAtomic(db),
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    clock: { now: () => new Date(START), sleep: () => Promise.resolve() },
    db,
    devFakeRuntime: false,
    gateways: [],
    spend: {
      enforceCap: () => Promise.resolve(),
      workspaceOver: () => {
        checks += 1;
        return Promise.resolve(false);
      },
    },
  });
  const startCounted = () =>
    counted.startRun(owner, {
      agentId: aId,
      input: { text: "hello" },
      session: { origin: "ui" },
    });

  await startCounted();
  expect(checks).toBe(0);

  setWorkspaceCap(10_000);
  await startCounted();
  expect(checks).toBe(1);
});

test("a team dream that takes the workspace over its cap holds new starts", async () => {
  setWorkspaceCap(CAP_CENTS);
  teamDream("td1", WEEK_OVER_CAP_USD);
  await expect(start(aId)).rejects.toMatchObject(
    refusedByWorkspaceLimit("Ada")
  );
});

test("a resumed agent starts once an admin raises the workspace cap above the week", async () => {
  setWorkspaceCap(CAP_CENTS);
  await spendOn(aId, WEEK_OVER_CAP_USD);
  await spend.resume(owner, { agentId: aId });
  await expect(start(aId)).rejects.toMatchObject(
    refusedByWorkspaceLimit("Ada")
  );

  await spend.setCap(admin, { agentId: null, weeklyCapCents: 10_000 });
  await start(aId);
});
