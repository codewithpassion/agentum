import { beforeEach, expect, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { ROUTINE_ERROR_LIMIT } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import { createRoutinesService, type RoutinesService } from "./routines.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
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
let allowedOrgIds: string[];
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
  clock = {
    now: () => new Date(nowMs),
    sleep: (ms) => {
      advance(ms);
      return Promise.resolve();
    },
  };
  dispatched = [];
  crashDispatches = 0;
  failWrites = 0;
  allowedOrgIds = [`org_${WORKSPACE}`, `org_${OTHER_WORKSPACE}`];
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
    allowedOrgIds,
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
    allowedOrgIds: [`org_${WORKSPACE}`],
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

test("a routine whose organisation is no longer allowed stops firing", async () => {
  await makeRoutine("* * * * *");
  advance(MINUTE_MS);
  allowedOrgIds.splice(0);

  expect((await tick()).fired).toEqual([]);
  expect(allRuns()).toEqual([]);

  allowedOrgIds.push(`org_${WORKSPACE}`);
  expect((await tick()).fired).toHaveLength(1);
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
