import { beforeEach, expect, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import {
  type ApiKeyAccess,
  isPendingProposal,
  type OAuthClientAccess,
  ROUTINE_ERROR_LIMIT,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import { createRoutinesService, type RoutinesService } from "./routines.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import {
  createRunsService,
  type RunsService,
  UNCLAIMED_EXPIRY_MS,
} from "./runs.ts";
import { createTriggersService } from "./triggers.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const SYDNEY = "Australia/Sydney";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u9",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let clock: Clock;
let dispatched: string[];
let crashDispatches: number;
let failWrites: number;
let onClockRead: (() => void) | null;
let agents: AgentsService;
let runs: RunsService;
let service: RoutinesService;
let agentId: string;

const setNow = (iso: string) => {
  nowMs = Date.parse(iso);
};
const advance = (ms: number) => {
  nowMs += ms;
};

const adapter: RuntimeAdapter = {
  cancel: () => Promise.resolve(),
  dispatch: (_db, run) => {
    if (crashDispatches > 0) {
      crashDispatches -= 1;
      return Promise.reject(new Error("worker crashed before dispatch"));
    }
    dispatched.push(run.id);
    return Promise.resolve();
  },
  kind: "machine",
};

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: SYDNEY,
    })
    .run();

const routineRow = (routineId: string) =>
  db.select().from(triggerRows).where(eq(triggerRows.id, routineId)).get();

const rowNext = (routineId: string) => routineRow(routineId)?.nextRunAt;

const allRuns = () => db.select().from(runRows).all();

const tick = () => service.fireDue(SYSTEM_PRINCIPAL);

const makeRoutine = (cron: string, timezone?: string) =>
  service.create(user, {
    agentId,
    cron,
    name: "Routine",
    prompt: "Do the thing",
    timezone,
  });

/** The slot a routine's run was written for, from its request id. */
const slotOf = (requestId: string | null): string =>
  (requestId ?? "").split(":").slice(2).join(":");

/** Ticks once a minute from `from` to `to` (inclusive). Returns the slots fired. */
const tickMinutes = async (from: string, to: string): Promise<string[]> => {
  const slots: string[] = [];
  for (setNow(from); nowMs <= Date.parse(to); advance(MINUTE_MS)) {
    // biome-ignore lint/performance/noAwaitInLoops: minutes pass in order
    const result = await tick();
    if (result.failed.length > 0) {
      throw new Error(`A tick failed: ${JSON.stringify(result.failed)}`);
    }
    for (const runId of result.fired) {
      const row = allRuns().find((run) => run.id === runId);
      slots.push(slotOf(row?.requestId ?? null));
    }
  }
  return slots;
};

beforeEach(async () => {
  db = migrated();
  setNow(START);
  onClockRead = null;
  clock = {
    now: () => {
      // A test hook: runs once, to change a row mid-call.
      const hook = onClockRead;
      onClockRead = null;
      hook?.();
      return new Date(nowMs);
    },
    sleep: (ms) => {
      advance(ms);
      return Promise.resolve();
    },
  };
  dispatched = [];
  crashDispatches = 0;
  failWrites = 0;
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const real = sqliteAtomic(db);
  const atomic: Atomic = (statements) => {
    if (failWrites > 0) {
      failWrites -= 1;
      return Promise.reject(new Error("d1 is down"));
    }
    return real(statements);
  };
  const events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  insertWorkspace(WORKSPACE);
  insertWorkspace(OTHER_WORKSPACE);
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
  agentId = (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Worker",
      runtime: "machine",
    })
  ).id;
  runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  service = createRoutinesService({
    clock,
    db,
    events,
    runs,
  });
});

test("create takes the workspace timezone and the next slot after now", async () => {
  const routine = await makeRoutine("*/5 * * * *");

  expect(routine.id.startsWith("rtn_")).toBe(true);
  expect(routine.timezone).toBe(SYDNEY);
  expect(routine.nextRunAt).toBe("2026-10-16T10:05:00.000Z");
  expect(routine.consecutiveErrors).toBe(0);
  expect(routine.disabledAt).toBeNull();
  expect(await service.list(user)).toEqual([routine]);
  expect((await makeRoutine("0 9 * * *", "UTC")).timezone).toBe("UTC");
});

test("create refuses a bad cron, a bad timezone, an unknown agent and a prompt-less routine", async () => {
  await expect(makeRoutine("not a cron")).rejects.toThrow(ServiceError);
  await expect(makeRoutine("0 9 * * *", "Mars/Olympus")).rejects.toThrow(
    "Unknown timezone"
  );
  await expect(makeRoutine("0 0 31 2 *")).rejects.toThrow("never fires");
  await expect(
    service.create(user, {
      agentId: "nope",
      cron: "* * * * *",
      name: "x",
      prompt: "y",
    })
  ).rejects.toThrow("Agent not found");
  await expect(
    service.create(user, {
      agentId,
      cron: "* * * * *",
      name: "x",
      prompt: "   ",
    })
  ).rejects.toThrow();
  await expect(
    service.create(outsider, {
      agentId,
      cron: "* * * * *",
      name: "x",
      prompt: "y",
    })
  ).rejects.toThrow("Agent not found");
});

test("routines and http triggers stay out of each other's lists", async () => {
  const events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const triggers = createTriggersService({
    clock,
    db,
    events,
    runs,
  });
  const routine = await makeRoutine("* * * * *");
  const { trigger } = await triggers.create(user, { agentId, name: "Hook" });

  expect((await service.list(user)).map((item) => item.id)).toEqual([
    routine.id,
  ]);
  expect((await triggers.list(user)).map((item) => item.id)).toEqual([
    trigger.id,
  ]);
  await expect(triggers.revoke(user, routine.id)).rejects.toThrow(
    "Trigger not found"
  );
});

test("another workspace cannot see, pause or remove a routine", async () => {
  const routine = await makeRoutine("* * * * *");

  expect(await service.list(outsider)).toEqual([]);
  await expect(
    service.setEnabled(outsider, { enabled: false, routineId: routine.id })
  ).rejects.toThrow("Routine not found");
  await expect(service.remove(outsider, routine.id)).rejects.toThrow(
    "Routine not found"
  );
});

test("only the minute tick fires or settles", async () => {
  await expect(service.fireDue(user)).rejects.toThrow(ForbiddenError);
  await expect(service.settleRuns(user)).rejects.toThrow(ForbiddenError);
});

test("a */5 routine fires once per slot, never twice", async () => {
  const routine = await makeRoutine("*/5 * * * *");

  // A tick every 10 seconds for 20 minutes covers four slots six times each.
  const slots: string[] = [];
  for (
    advance(10 * SECOND_MS);
    nowMs < Date.parse(START) + 20 * MINUTE_MS;
    advance(10 * SECOND_MS)
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: ticks run in order
    const result = await tick();
    slots.push(
      ...result.fired.map((runId) =>
        slotOf(allRuns().find((run) => run.id === runId)?.requestId ?? null)
      )
    );
  }

  expect(slots).toEqual([
    "2026-10-16T10:05:00.000Z",
    "2026-10-16T10:10:00.000Z",
    "2026-10-16T10:15:00.000Z",
  ]);
  const rows = allRuns();
  expect(rows.map((run) => run.requestId).toSorted()).toEqual(
    slots.map((slot) => `trigger:${routine.id}:${slot}`)
  );
  expect(dispatched).toHaveLength(3);
  expect(rows.every((run) => run.inputText === "Do the thing")).toBe(true);
  expect(rows.every((run) => run.actorKind === "trigger")).toBe(true);
  expect(rowNext(routine.id)).toBe("2026-10-16T10:20:00.000Z");
});

test("two ticks for the same minute make one run, and the second reads it back", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);

  const first = await tick();
  expect(first.fired).toHaveLength(1);
  // The second tick read the row before the first one wrote.
  db.update(triggerRows)
    .set({ nextRunAt: "2026-10-16T10:01:00.000Z" })
    .where(eq(triggerRows.id, routine.id))
    .run();
  const second = await tick();

  expect(second.fired).toEqual([]);
  expect(second.readBack).toEqual(first.fired);
  expect(second.failed).toEqual([]);
  expect(allRuns()).toHaveLength(1);
  expect(dispatched).toEqual(first.fired);
  expect(rowNext(routine.id)).toBe("2026-10-16T10:02:00.000Z");
});

test("two ticks that run together still make one run", async () => {
  await makeRoutine("* * * * *");
  advance(MINUTE_MS);

  const [a, b] = await Promise.all([tick(), tick()]);

  expect(allRuns()).toHaveLength(1);
  expect(a.fired.length + b.fired.length).toBe(1);
  expect(dispatched).toHaveLength(1);
});

test("a tick whose atomic write fails leaves next_run_at at the due slot, and the next tick fires it", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  failWrites = 1;

  const failed = await tick();

  expect(failed.fired).toEqual([]);
  expect(failed.failed).toEqual([
    { message: "d1 is down", routineId: routine.id },
  ]);
  expect(rowNext(routine.id)).toBe("2026-10-16T10:01:00.000Z");
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(1);
  expect(allRuns()).toEqual([]);

  advance(10 * SECOND_MS);
  const retried = await tick();

  expect(retried.fired).toHaveLength(1);
  expect(
    slotOf(
      allRuns().find((run) => run.id === retried.fired[0])?.requestId ?? null
    )
  ).toBe("2026-10-16T10:01:00.000Z");
  expect(rowNext(routine.id)).toBe("2026-10-16T10:02:00.000Z");
});

test("a crash after the write and before dispatch leaves a queued run that the sweep offers", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  crashDispatches = 1;

  const crashed = await tick();

  expect(crashed.failed).toHaveLength(1);
  const [queued] = allRuns();
  expect(queued?.status).toBe("queued");
  expect(dispatched).toEqual([]);
  // The write landed, so the slot is spent and the failure is not the routine's.
  expect(rowNext(routine.id)).toBe("2026-10-16T10:02:00.000Z");
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(0);

  advance(59 * SECOND_MS);
  expect((await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL)).offered).toEqual([]);

  advance(2 * SECOND_MS);
  const swept = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(swept.offered).toEqual([queued?.id ?? ""]);
  expect(dispatched).toEqual([queued?.id ?? ""]);
});

test("five failed slots in a row switch the routine off, and resuming starts clean", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  failWrites = ROUTINE_ERROR_LIMIT;

  for (let attempt = 1; attempt <= ROUTINE_ERROR_LIMIT; attempt += 1) {
    expect(routineRow(routine.id)?.disabledAt).toBeNull();
    // biome-ignore lint/performance/noAwaitInLoops: attempts run in order
    await tick();
  }

  const off = routineRow(routine.id);
  expect(off?.consecutiveErrors).toBe(ROUTINE_ERROR_LIMIT);
  expect(off?.disabledAt).toBe("2026-10-16T10:01:00.000Z");
  expect(off?.lastError).toBe("d1 is down");
  expect((await tick()).fired).toEqual([]);
  expect(allRuns()).toEqual([]);

  advance(5 * MINUTE_MS);
  const resumed = await service.setEnabled(user, {
    enabled: true,
    routineId: routine.id,
  });
  expect(resumed.consecutiveErrors).toBe(0);
  expect(resumed.disabledAt).toBeNull();
  expect(resumed.lastError).toBeNull();
  expect(resumed.nextRunAt).toBe("2026-10-16T10:07:00.000Z");
});

test("pausing stops the routine and removing hides it", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);

  const paused = await service.setEnabled(user, {
    enabled: false,
    routineId: routine.id,
  });
  expect(paused.disabledAt).toBe("2026-10-16T10:01:00.000Z");
  expect((await tick()).fired).toEqual([]);

  await service.remove(user, routine.id);
  expect(await service.list(user)).toEqual([]);
  expect(routineRow(routine.id)?.revokedAt).toBe("2026-10-16T10:01:00.000Z");
  await expect(service.remove(user, routine.id)).rejects.toThrow(
    "Routine not found"
  );
});

test("failed and interrupted runs count, done clears, cancelled counts for nothing", async () => {
  const routine = await makeRoutine("* * * * *");

  const finish = async (
    status: "cancelled" | "done" | "failed" | "interrupted"
  ) => {
    advance(MINUTE_MS);
    const [runId] = (await tick()).fired;
    db.update(runRows)
      .set({ error: status === "failed" ? "boom" : null, status })
      .where(eq(runRows.id, runId ?? ""))
      .run();
    return await service.settleRuns(SYSTEM_PRINCIPAL);
  };

  expect(await finish("failed")).toEqual({ settled: 1 });
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(routine.id)?.lastError).toBe("boom");
  expect(routineRow(routine.id)?.settledRunId).not.toBeNull();
  await finish("interrupted");
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(2);
  await finish("cancelled");
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(2);
  // Settling twice changes nothing: the run was already judged.
  expect(await service.settleRuns(SYSTEM_PRINCIPAL)).toEqual({ settled: 0 });
  await finish("done");
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(0);
  expect(routineRow(routine.id)?.lastError).toBeNull();
});

test("five failed runs in a row switch the routine off", async () => {
  const routine = await makeRoutine("* * * * *");

  for (let attempt = 1; attempt <= ROUTINE_ERROR_LIMIT; attempt += 1) {
    advance(MINUTE_MS);
    // biome-ignore lint/performance/noAwaitInLoops: runs end in order
    const [runId] = (await tick()).fired;
    db.update(runRows)
      .set({ error: "no machine", status: "failed" })
      .where(eq(runRows.id, runId ?? ""))
      .run();
    await service.settleRuns(SYSTEM_PRINCIPAL);
  }

  expect(routineRow(routine.id)?.disabledAt).not.toBeNull();
  advance(MINUTE_MS);
  expect((await tick()).fired).toEqual([]);
  expect(allRuns()).toHaveLength(ROUTINE_ERROR_LIMIT);
});

test("a routine whose machine never claims switches itself off after five expired runs", async () => {
  const routine = await makeRoutine("* * * * *");
  const firstSlot = Date.parse(START) + MINUTE_MS;

  // Nothing claims a run, so each one fails only once it is an hour old.
  for (let minute = 0; minute < 120; minute += 1) {
    advance(MINUTE_MS);
    // biome-ignore lint/performance/noAwaitInLoops: minutes pass in order
    await tick();
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
    await service.settleRuns(SYSTEM_PRINCIPAL);

    const row = routineRow(routine.id);
    if (nowMs - firstSlot < UNCLAIMED_EXPIRY_MS) {
      expect(row?.disabledAt).toBeNull();
      expect(row?.consecutiveErrors).toBe(0);
    }
    if (row?.disabledAt) {
      break;
    }
  }

  const off = routineRow(routine.id);
  expect(off?.consecutiveErrors).toBe(ROUTINE_ERROR_LIMIT);
  expect(off?.lastError).toBe("Never claimed");
  const minutesToDisable =
    (Date.parse(off?.disabledAt ?? "") - firstSlot) / MINUTE_MS;
  expect(minutesToDisable).toBeGreaterThanOrEqual(60);
  expect(minutesToDisable).toBeLessThanOrEqual(70);

  const staleCutoff = nowMs - 61 * MINUTE_MS;
  const unfinished = allRuns().filter(
    (run) =>
      (run.status === "queued" || run.status === "offered") &&
      Date.parse(run.createdAt) < staleCutoff
  );
  expect(unfinished).toEqual([]);
});

test("slots missed while the tick was down collapse into one run", async () => {
  const routine = await makeRoutine("*/5 * * * *");
  advance(63 * MINUTE_MS);

  const result = await tick();

  expect(result.fired).toHaveLength(1);
  expect(
    slotOf(
      allRuns().find((run) => run.id === result.fired[0])?.requestId ?? null
    )
  ).toBe("2026-10-16T10:05:00.000Z");
  expect(rowNext(routine.id)).toBe("2026-10-16T11:05:00.000Z");
});

test("a daily Sydney routine neither skips nor doubles across the spring-forward gap", async () => {
  setNow("2025-10-04T12:00:00.000Z");
  await makeRoutine("30 2 * * *");

  const slots = await tickMinutes(
    "2025-10-04T12:00:00.000Z",
    "2025-10-05T20:00:00.000Z"
  );

  // 02:30 does not exist on Sun 5 Oct, so the run comes when the gap ends,
  // 03:00 AEDT. Mon 6 Oct 02:30 AEDT follows.
  expect(slots).toEqual([
    "2025-10-04T16:00:00.000Z",
    "2025-10-05T15:30:00.000Z",
  ]);
});

test("a daily Sydney routine neither skips nor doubles across the fall-back hour", async () => {
  setNow("2025-04-05T00:00:00.000Z");
  await makeRoutine("30 2 * * *");

  const slots = await tickMinutes(
    "2025-04-05T00:00:00.000Z",
    "2025-04-07T00:00:00.000Z"
  );

  // 02:30 happens twice on Sun 6 Apr; only the first pass fires.
  expect(slots).toEqual([
    "2025-04-05T15:30:00.000Z",
    "2025-04-06T16:30:00.000Z",
  ]);
});

test("a half-hourly Sydney routine keeps real time across both changes", async () => {
  for (const [from, to] of [
    ["2025-10-04T14:00:00.000Z", "2025-10-04T18:00:00.000Z"],
    ["2025-04-05T14:00:00.000Z", "2025-04-05T18:00:00.000Z"],
  ] as const) {
    // A fresh routine for each window; the earlier one is paused.
    setNow(from);
    for (const old of await service.list(user)) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of rows
      await service.remove(user, old.id);
    }
    await makeRoutine("*/30 * * * *");

    const slots = await tickMinutes(from, to);

    const start = Date.parse(from);
    expect(slots).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        new Date(start + (index + 1) * 30 * MINUTE_MS).toISOString()
      )
    );
  }
});

test("the tick fires the routines of every workspace", async () => {
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "h2",
      enrolledBy: "u9",
      id: "m2",
      name: "m2",
      singleUser: false,
      status: "online",
      workspaceId: OTHER_WORKSPACE,
    })
    .run();
  const otherAgent = await agents.create(outsider, {
    machineId: "m2",
    model: "m",
    name: "Other worker",
    runtime: "machine",
  });
  const first = await makeRoutine("* * * * *");
  const second = await service.create(outsider, {
    agentId: otherAgent.id,
    cron: "* * * * *",
    name: "Other routine",
    prompt: "Do the other thing",
  });
  advance(MINUTE_MS);

  const result = await tick();

  expect(result.fired).toHaveLength(2);
  const firedFor = allRuns()
    .filter((run) => result.fired.includes(run.id))
    .map((run) => run.workspaceId)
    .sort();
  expect(firedFor).toEqual([WORKSPACE, OTHER_WORKSPACE]);
  expect(first.id).not.toBe(second.id);
});

const endRun = (runId: string | undefined, status: "done" | "failed") =>
  db
    .update(runRows)
    .set({ error: status === "failed" ? "late failure" : null, status })
    .where(eq(runRows.id, runId ?? ""))
    .run();

test("a run that outlives its slot holds back the later ones, and every run is counted once", async () => {
  const routine = await makeRoutine("* * * * *");
  const fired: (string | undefined)[] = [];
  for (let slot = 0; slot < 3; slot += 1) {
    advance(MINUTE_MS);
    // biome-ignore lint/performance/noAwaitInLoops: slots pass in order
    fired.push((await tick()).fired[0]);
  }

  // The newest two ended; the first is still running, so nothing is judged yet.
  endRun(fired[1], "failed");
  endRun(fired[2], "failed");
  expect(await service.settleRuns(SYSTEM_PRINCIPAL)).toEqual({ settled: 0 });
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(0);

  endRun(fired[0], "done");
  expect(await service.settleRuns(SYSTEM_PRINCIPAL)).toEqual({ settled: 1 });
  expect(routineRow(routine.id)?.consecutiveErrors).toBe(2);
  expect(routineRow(routine.id)?.lastError).toBe("late failure");
  expect(routineRow(routine.id)?.settledRunId).toBe(fired[2] ?? "");
  expect(await service.settleRuns(SYSTEM_PRINCIPAL)).toEqual({ settled: 0 });
});

test("a run fired while the settle job runs is judged by the next one", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  const [first] = (await tick()).fired;
  endRun(first, "failed");
  advance(MINUTE_MS);
  const [second] = (
    await Promise.all([tick(), service.settleRuns(SYSTEM_PRINCIPAL)])
  )[0].fired;
  endRun(second, "failed");
  await service.settleRuns(SYSTEM_PRINCIPAL);

  expect(routineRow(routine.id)?.consecutiveErrors).toBe(2);
  expect(routineRow(routine.id)?.settledRunId).toBe(second ?? "");
});

test("failures that a done run interrupts do not add up to five", async () => {
  const routine = await makeRoutine("* * * * *");
  const sequence = [
    "failed",
    "failed",
    "failed",
    "failed",
    "done",
    "failed",
  ] as const;
  for (const status of sequence) {
    advance(MINUTE_MS);
    // biome-ignore lint/performance/noAwaitInLoops: slots pass in order
    endRun((await tick()).fired[0], status);
  }
  await service.settleRuns(SYSTEM_PRINCIPAL);

  expect(routineRow(routine.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(routine.id)?.disabledAt).toBeNull();
});

test("a routine with a backlog of unfinished runs does not starve the others", async () => {
  const backlogged = await makeRoutine("* * * * *");
  advance(SECOND_MS);
  const other = await makeRoutine("* * * * *");
  let otherRun: string | undefined;
  // 600 slots: the first routine's runs stay queued, so they outnumber any row limit.
  for (let slot = 0; slot < 600; slot += 1) {
    advance(MINUTE_MS);
    // biome-ignore lint/performance/noAwaitInLoops: slots pass in order
    const result = await tick();
    otherRun ??= result.fired
      .map((runId) => allRuns().find((run) => run.id === runId))
      .find((run) => run?.actorId === other.id)?.id;
  }
  endRun(otherRun, "failed");

  expect(await service.settleRuns(SYSTEM_PRINCIPAL)).toEqual({ settled: 1 });
  expect(routineRow(other.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(backlogged.id)?.consecutiveErrors).toBe(0);
});

test("settle keeps a pause that lands between its read and its write", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  endRun((await tick()).fired[0], "failed");
  // The clock is read after the verdict is worked out and before the write.
  onClockRead = () =>
    db
      .update(triggerRows)
      .set({ disabledAt: "2026-10-16T10:01:30.000Z" })
      .where(eq(triggerRows.id, routine.id))
      .run();

  await service.settleRuns(SYSTEM_PRINCIPAL);

  expect(routineRow(routine.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(routine.id)?.disabledAt).toBe("2026-10-16T10:01:30.000Z");
});

test("settle keeps a resume that lands between its read and its write", async () => {
  const routine = await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  endRun((await tick()).fired[0], "failed");
  await service.setEnabled(user, { enabled: false, routineId: routine.id });
  onClockRead = () =>
    db
      .update(triggerRows)
      .set({ disabledAt: null })
      .where(eq(triggerRows.id, routine.id))
      .run();

  await service.settleRuns(SYSTEM_PRINCIPAL);

  expect(routineRow(routine.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(routine.id)?.disabledAt).toBeNull();
});

test("routines stuck behind an unfinished run cannot take every candidate slot", async () => {
  // More stuck routines than one settle call takes: each has an oldest run
  // that never ends and a later run that failed. Then a healthy routine,
  // which sorts after all of them.
  const stuck: string[] = [];
  for (let index = 0; index < 105; index += 1) {
    advance(SECOND_MS);
    // biome-ignore lint/performance/noAwaitInLoops: ids sort by creation time
    stuck.push((await makeRoutine("* * * * *")).id);
  }
  advance(SECOND_MS);
  const healthy = await makeRoutine("* * * * *");
  const runsOf = (routineId: string) =>
    allRuns()
      .filter((run) => run.actorId === routineId)
      .map((run) => run.id)
      .toSorted();

  for (let slot = 0; slot < 2; slot += 1) {
    advance(MINUTE_MS);
    // One tick takes at most 100 routines; tick until the slot is spent.
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: ticks run in order
      const result = await tick();
      if (result.fired.length === 0) {
        break;
      }
    }
  }
  for (const routineId of stuck) {
    endRun(runsOf(routineId)[1], "failed");
  }
  endRun(runsOf(healthy.id)[0], "failed");

  await service.settleRuns(SYSTEM_PRINCIPAL);

  expect(routineRow(healthy.id)?.consecutiveErrors).toBe(1);
  expect(routineRow(stuck[0] ?? "")?.consecutiveErrors).toBe(0);
});

test("with more routines than one settle call takes, the one that waited longest goes first", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    advance(SECOND_MS);
    // biome-ignore lint/performance/noAwaitInLoops: ids sort by creation time
    ids.push((await makeRoutine("* * * * *")).id);
  }
  const lastId = ids.at(-1) ?? "";

  // Every minute all 101 routines fire and every run fails at once.
  for (let minute = 0; minute < 3; minute += 1) {
    advance(MINUTE_MS);
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: ticks run in order
      const result = await tick();
      if (result.fired.length === 0) {
        break;
      }
    }
    db.update(runRows)
      .set({ error: "no machine", status: "failed" })
      .where(eq(runRows.status, "queued"))
      .run();
    await service.settleRuns(SYSTEM_PRINCIPAL);
  }

  // Sorted by id, the first 100 would take every slot and this one stay at 0.
  expect(routineRow(lastId)?.consecutiveErrors).toBeGreaterThan(0);
});

// Managing routines: principals, proposals and approval.

const apiKeyUser = (access: ApiKeyAccess): Principal => ({
  apiKey: { access, id: "key1" },
  kind: "user",
  userId: "u1",
  via: "api_key",
  workspaceId: WORKSPACE,
});
const oauthUser = (access: OAuthClientAccess): Principal => ({
  kind: "user",
  oauthClient: { access, clientId: "c1" },
  userId: "u1",
  via: "oauth",
  workspaceId: WORKSPACE,
});
const slackUser: Principal = {
  kind: "user",
  userId: "u1",
  via: "slack",
  workspaceId: WORKSPACE,
};
const machinePrincipal: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: WORKSPACE,
};

type RunPrincipal = Extract<Principal, { kind: "run" }>;

/** Starts a real run for `agent` and returns the principal that run acts as. */
const runAs = async (agent: string): Promise<RunPrincipal> => {
  const started = await runs.startRun(user, {
    agentId: agent,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  return {
    agentId: agent,
    kind: "run",
    runId: started.runId,
    workspaceId: WORKSPACE,
  };
};

const secondAgent = async (): Promise<string> =>
  (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Other",
      runtime: "machine",
    })
  ).id;

/** A routine a run proposes for `agent`, on the every-minute schedule. */
const propose = (principal: RunPrincipal, agent = agentId) =>
  service.create(principal, {
    agentId: agent,
    cron: "* * * * *",
    name: "Proposed",
    prompt: "Do the thing",
  });

const routineFor = (agent: string, name = "Other") =>
  service.create(user, {
    agentId: agent,
    cron: "* * * * *",
    name,
    prompt: "Do the thing",
  });

/** Every event of one type, with its payload parsed. */
const eventsOfType = (type: string) =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, type))
    .all()
    .map((row) => ({
      actorId: row.actorId,
      actorKind: row.actorKind,
      payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
      runId: row.runId,
    }));

const eventFor = (type: string, triggerId: string) =>
  eventsOfType(type).find((event) => event.payload.triggerId === triggerId);

const allEventCount = () => db.select().from(eventRows).all().length;

const requireRow = (routineId: string) => {
  const row = routineRow(routineId);
  if (row === undefined) {
    throw new Error(`No trigger row ${routineId}`);
  }
  return row;
};

/** The error a call rejects with. Fails the test if the call resolves. */
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
};

test("a person creates a routine that is enabled and logged", async () => {
  const routine = await makeRoutine("* * * * *");

  expect(routine).toMatchObject({
    approvedAt: null,
    disabledAt: null,
    nextRunAt: "2026-10-16T10:01:00.000Z",
    proposedByAgentId: null,
    proposedByRunId: null,
  });
  expect(eventsOfType("trigger.created")).toHaveLength(1);
  expect(eventFor("trigger.created", routine.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
    payload: {
      kind: "routine",
      name: "Routine",
      principal: { userId: "u1", via: "session" },
      proposed: false,
    },
  });
});

test("an API key or OAuth client with write access creates routines, and the log names the key or client", async () => {
  const keyed = await routineFor(agentId, "Keyed");
  const client = await service.create(oauthUser("write"), {
    agentId,
    cron: "* * * * *",
    name: "Client",
    prompt: "Do the thing",
  });
  const byKey = await service.create(apiKeyUser("write"), {
    agentId,
    cron: "* * * * *",
    name: "ByKey",
    prompt: "Do the thing",
  });

  expect(keyed.disabledAt).toBeNull();
  expect(client.disabledAt).toBeNull();
  expect(byKey.disabledAt).toBeNull();
  expect(eventFor("trigger.created", keyed.id)?.payload.principal).toEqual({
    userId: "u1",
    via: "session",
  });
  expect(eventFor("trigger.created", byKey.id)?.payload.principal).toEqual({
    keyId: "key1",
    userId: "u1",
    via: "api_key",
  });
  expect(eventFor("trigger.created", client.id)?.payload.principal).toEqual({
    clientId: "c1",
    userId: "u1",
    via: "oauth",
  });
});

test("a read-only API key or OAuth client lists routines but changes none", async () => {
  const own = await makeRoutine("* * * * *");
  const pending = await propose(await runAs(agentId));

  for (const reader of [apiKeyUser("read"), oauthUser("read")]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: readers are checked in order
      (await service.list(reader)).map((item) => item.id).toSorted()
    ).toEqual([own.id, pending.id].toSorted());
    await expect(
      service.create(reader, {
        agentId,
        cron: "* * * * *",
        name: "x",
        prompt: "y",
      })
    ).rejects.toThrow(ForbiddenError);
    await expect(
      service.setEnabled(reader, { enabled: false, routineId: own.id })
    ).rejects.toThrow(ForbiddenError);
    await expect(service.remove(reader, own.id)).rejects.toThrow(
      ForbiddenError
    );
    await expect(service.approve(reader, pending.id)).rejects.toThrow(
      ForbiddenError
    );
    await expect(service.reject(reader, pending.id)).rejects.toThrow(
      ForbiddenError
    );
  }
  expect(requireRow(own.id).disabledAt).toBeNull();
  expect(requireRow(pending.id).approvedAt).toBeNull();
});

test("Slack senders, machines and triggers get no access to routines, not even to list", async () => {
  await makeRoutine("* * * * *");

  const triggerPrincipal: Principal = {
    agentId,
    kind: "trigger",
    triggerId: "t1",
    workspaceId: WORKSPACE,
  };
  for (const other of [slackUser, machinePrincipal, triggerPrincipal]) {
    // biome-ignore lint/performance/noAwaitInLoops: principals are checked in order
    await expect(service.list(other)).rejects.toThrow(ForbiddenError);
    await expect(
      service.create(other, {
        agentId,
        cron: "* * * * *",
        name: "x",
        prompt: "y",
      })
    ).rejects.toThrow(ForbiddenError);
  }
});

test("a run proposes a routine for its own agent, stored paused and marked as proposed", async () => {
  const run = await runAs(agentId);

  const proposal = await propose(run);

  expect(proposal).toMatchObject({
    agentId,
    approvedAt: null,
    disabledAt: START,
    nextRunAt: null,
    proposedByAgentId: agentId,
    proposedByRunId: run.runId,
  });
  expect(eventFor("trigger.created", proposal.id)).toMatchObject({
    actorId: agentId,
    actorKind: "agent",
    payload: {
      principal: { agentId, runId: run.runId, via: "run" },
      proposed: true,
    },
    runId: run.runId,
  });
});

test("a run cannot propose a routine for another agent", async () => {
  const run = await runAs(agentId);
  const other = await secondAgent();

  await expect(propose(run, other)).rejects.toThrow(ForbiddenError);
  expect(eventsOfType("trigger.created")).toEqual([]);
});

test("a proposal that is still waiting never fires", async () => {
  const run = await runAs(agentId);
  const proposal = await propose(run);

  expect(await tickMinutes(START, "2026-10-16T10:10:00.000Z")).toEqual([]);
  expect(allRuns().filter((item) => item.actorId === proposal.id)).toEqual([]);
});

test("a run cannot enable a routine, not its own proposal and not a person's", async () => {
  const run = await runAs(agentId);
  const proposal = await propose(run);
  const personal = await makeRoutine("* * * * *");

  await expect(
    service.setEnabled(run, { enabled: true, routineId: proposal.id })
  ).rejects.toThrow(ForbiddenError);
  await expect(
    service.setEnabled(run, { enabled: true, routineId: personal.id })
  ).rejects.toThrow(ForbiddenError);
  expect(requireRow(proposal.id).disabledAt).toBe(START);
  expect(requireRow(proposal.id).approvedAt).toBeNull();
});

test("a run can pause a routine of its own agent, but not one of another agent", async () => {
  const run = await runAs(agentId);
  const personal = await makeRoutine("* * * * *");
  const other = await routineFor(await secondAgent());

  const paused = await service.setEnabled(run, {
    enabled: false,
    routineId: personal.id,
  });
  expect(paused.disabledAt).toBe(START);
  await expect(
    service.setEnabled(run, { enabled: false, routineId: other.id })
  ).rejects.toThrow(ForbiddenError);
  expect(requireRow(other.id).disabledAt).toBeNull();
});

test("a run removes only a routine its own agent proposed", async () => {
  const run = await runAs(agentId);
  const proposal = await propose(run);
  const personal = await makeRoutine("* * * * *");

  await expect(service.remove(run, personal.id)).rejects.toThrow(
    ForbiddenError
  );
  expect(requireRow(personal.id).revokedAt).toBeNull();

  await service.remove(run, proposal.id);

  expect(requireRow(proposal.id).revokedAt).toBe(START);
  expect(eventFor("trigger.deleted", proposal.id)).toMatchObject({
    actorId: agentId,
    actorKind: "agent",
    runId: run.runId,
  });
});

test("a run lists only its own agent's routines", async () => {
  const run = await runAs(agentId);
  const personal = await makeRoutine("* * * * *");
  const other = await secondAgent();
  await routineFor(other);

  expect((await service.list(run)).map((item) => item.id)).toEqual([
    personal.id,
  ]);
  await expect(service.list(run, { agentId: other })).rejects.toThrow(
    ForbiddenError
  );
});

test("a person approves a proposal, and it fires on its first slot", async () => {
  const proposal = await propose(await runAs(agentId));

  const approved = await service.approve(user, proposal.id);

  expect(approved).toMatchObject({
    approvedAt: START,
    disabledAt: null,
    nextRunAt: "2026-10-16T10:01:00.000Z",
  });
  expect(eventFor("trigger.approved", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
    payload: { principal: { via: "session" } },
  });
  expect(await tickMinutes(START, "2026-10-16T10:01:30.000Z")).toEqual([
    "2026-10-16T10:01:00.000Z",
  ]);
});

test("approve refuses a routine a person made, a run, and another workspace", async () => {
  const personal = await makeRoutine("* * * * *");
  const conflict = await errorOf(service.approve(user, personal.id));
  expect(conflict).toBeInstanceOf(ServiceError);
  expect(conflict).toMatchObject({ code: "conflict" });

  const run = await runAs(agentId);
  const forRun = await propose(run);
  await expect(service.approve(run, forRun.id)).rejects.toThrow(ForbiddenError);

  const foreign = await errorOf(service.approve(outsider, forRun.id));
  expect(
    foreign instanceof ForbiddenError ||
      (foreign instanceof ServiceError && foreign.code === "not_found")
  ).toBe(true);
  expect(requireRow(forRun.id).approvedAt).toBeNull();
  expect(eventsOfType("trigger.approved")).toEqual([]);
});

test("resuming a proposal approves it, and pausing and resuming after that log nothing", async () => {
  const proposal = await propose(await runAs(agentId));

  const resumed = await service.setEnabled(user, {
    enabled: true,
    routineId: proposal.id,
  });
  expect(resumed).toMatchObject({ approvedAt: START, disabledAt: null });
  expect(
    eventsOfType("trigger.approved").filter(
      (event) => event.payload.triggerId === proposal.id
    )
  ).toHaveLength(1);

  const logged = allEventCount();
  await service.setEnabled(user, { enabled: false, routineId: proposal.id });
  expect(allEventCount()).toBe(logged);
  await service.setEnabled(user, { enabled: true, routineId: proposal.id });
  expect(allEventCount()).toBe(logged);
  expect(isPendingProposal(requireRow(proposal.id))).toBe(false);
});

test("reject removes a proposal from the list and logs it as rejected", async () => {
  const proposal = await propose(await runAs(agentId));

  await service.reject(user, proposal.id);

  expect(requireRow(proposal.id).revokedAt).toBe(START);
  expect((await service.list(user)).map((item) => item.id)).not.toContain(
    proposal.id
  );
  expect(eventFor("trigger.rejected", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
  });
  expect(eventFor("trigger.deleted", proposal.id)).toBeUndefined();
});

test("reject refuses a routine that is not a proposal", async () => {
  const personal = await makeRoutine("* * * * *");

  const error = await errorOf(service.reject(user, personal.id));
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "conflict" });
  expect(requireRow(personal.id).revokedAt).toBeNull();
});

test("remove on a pending proposal logs a deletion, not a rejection", async () => {
  const proposal = await propose(await runAs(agentId));

  await service.remove(user, proposal.id);

  expect(requireRow(proposal.id).revokedAt).toBe(START);
  expect(eventFor("trigger.deleted", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
  });
  expect(eventFor("trigger.rejected", proposal.id)).toBeUndefined();
});

test("removing a routine twice fails the second time and logs once", async () => {
  const routine = await makeRoutine("* * * * *");
  await service.remove(user, routine.id);

  const error = await errorOf(service.remove(user, routine.id));

  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "not_found" });
  expect(eventsOfType("trigger.deleted")).toHaveLength(1);
});
