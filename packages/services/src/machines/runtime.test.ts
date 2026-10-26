import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService, findAgent } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { toRecord } from "../runs/records.ts";
import type { AdapterDeps, Clock } from "../runs/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createMachineRuntime } from "./runtime.ts";
import type { MachineRelayPort } from "./types.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const MACHINE_ID = "m1";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let clock: Clock;
let offers: { machineId: string; offer: { agentId: string; runId: string } }[];
let cancels: [string, string][];
let offerError: Error | null;
let relay: MachineRelayPort;
let runs: RunsService;
let agentId: string;

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
  };
  offers = [];
  cancels = [];
  offerError = null;
  relay = {
    announce: () => Promise.resolve(),
    cancel: (machineId, runId) => {
      cancels.push([machineId, runId]);
      return Promise.resolve();
    },
    offer: (machineId, offer) => {
      offers.push({ machineId, offer });
      return offerError ? Promise.reject(offerError) : Promise.resolve();
    },
    revoke: () => Promise.resolve(),
  };

  db.insert(workspaces)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "h",
      enrolledBy: "u1",
      id: MACHINE_ID,
      lastSeenAt: null,
      name: "laptop",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();

  const store = new Map<string, string>();
  const events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  const agent = await createAgentsService({ db, events }).create(user, {
    machineId: MACHINE_ID,
    model: "m",
    name: "Box",
    runtime: "machine",
  });
  agentId = agent.id;

  runs = createRunsService({
    adapters: [createMachineRuntime({ relay })],
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
});

test("startRun offers the new run to the machine and marks it offered", async () => {
  const started = await runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  expect(offers).toEqual([
    {
      machineId: MACHINE_ID,
      offer: { agentId, runId: started.runId },
    },
  ]);
  expect(runRow(started.runId)?.status).toBe("offered");
});

test("startRun still resolves and leaves the run offered when the relay fails", async () => {
  offerError = new Error("relay down");
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const started = await runs.startRun(user, {
      agentId,
      input: { text: "hello" },
      session: { origin: "ui" },
    });

    expect(offers).toHaveLength(1);
    expect(runRow(started.runId)?.status).toBe("offered");
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test("dispatch leaves a run that is already running as running", async () => {
  const started = await runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, started.runId))
    .run();
  const row = runRow(started.runId);
  const agent = await findAgent(db, { id: agentId });
  if (!(row && agent)) {
    throw new Error("the run and its agent should exist");
  }
  const unused = () => Promise.reject(new Error("dispatch does not use this"));
  const deps: AdapterDeps = {
    claimRun: unused,
    clock,
    completeRun: unused,
    ingestRunEvents: unused,
  };

  await createMachineRuntime({ relay }).dispatch(
    db,
    toRecord(row),
    agent,
    deps
  );

  expect(runRow(started.runId)?.status).toBe("running");
});

test("cancelRun tells the machine to stop the run", async () => {
  const started = await runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  await runs.cancelRun(user, started.runId);

  expect(cancels).toEqual([[MACHINE_ID, started.runId]]);
  expect(runRow(started.runId)?.status).toBe("cancelled");
});

test("the minute sweep offers a run queued for over 60 seconds again", async () => {
  const started = await runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });
  expect(offers).toHaveLength(1);

  nowMs += 61_000;
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

  expect(offers).toHaveLength(2);
  expect(offers[1]).toEqual({
    machineId: MACHINE_ID,
    offer: { agentId, runId: started.runId },
  });
});
