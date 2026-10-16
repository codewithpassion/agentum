import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { createMachineRuntime } from "../machines/runtime.ts";
import { noopRelay } from "../machines/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import type { Principal } from "../workspaces.ts";
import type { Clock } from "./types.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PLATFORM = "https://hm.example/";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const machine = (machineId: string): Principal => ({
  kind: "machine",
  machineId,
  workspaceId: WORKSPACE,
});

let db: ReturnType<typeof migrated>;
let nowMs: number;
let runs: RunsService;
let agentId: string;
let otherAgentId: string;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const status = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const start = async (agent: string, externalKey?: string) => {
  nowMs += 1000;
  return await runs.startRun(user, {
    agentId: agent,
    input: { text: "hi" },
    session: { externalKey, origin: "ui" },
  });
};

const claim = (machineId: string, runId: string) =>
  runs.claimRunForMachine(machine(machineId), runId, {
    platformUrl: PLATFORM,
  });

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected the call to reject");
};

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  for (const id of ["m1", "m2"]) {
    db.insert(machines)
      .values({
        capabilities: "{}",
        createdAt: START,
        credentialHash: id,
        enrolledBy: "u1",
        id,
        lastSeenAt: null,
        name: id,
        singleUser: false,
        status: "online",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const agents = createAgentsService({
    db,
    events: createEventsService({ blobs, db }),
  });
  agentId = (
    await agents.create(user, {
      instructions: "Be brief.",
      machineId: "m1",
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).id;
  otherAgentId = (
    await agents.create(user, {
      machineId: "m2",
      model: "m",
      name: "Other",
      runtime: "machine",
    })
  ).id;
  runs = createRunsService({
    adapters: [createMachineRuntime({ relay: noopRelay })],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
    runTokenKey: KEY,
  });
});

test("a claim returns the run, agent, session, token and platform entry", async () => {
  const started = await start(agentId);

  const claimed = await claim("m1", started.runId);

  expect(claimed.run).toEqual({
    agentId,
    id: started.runId,
    inputText: "hi",
    sessionId: started.sessionId,
    workspaceId: WORKSPACE,
  });
  expect(claimed.agent.name).toBe("Box");
  expect(claimed.instructions).toBe("Be brief.");
  expect(claimed.inputFileIds).toEqual([]);
  expect(claimed.session).toEqual({
    id: started.sessionId,
    runtimeMachineId: null,
    runtimeRef: null,
  });
  expect(claimed.runToken.startsWith("hm_run_")).toBe(true);
  expect(claimed.mcpServers.harbourmaster).toEqual({
    headers: { Authorization: `Bearer ${claimed.runToken}` },
    type: "http",
    url: "https://hm.example/mcp",
  });
  const row = status(started.runId);
  expect(row?.status).toBe("running");
  expect(row?.claimedBy).toBe("m1");
  expect(row?.leaseUntil).toBe(new Date(nowMs + 90_000).toISOString());
});

test("a second claim of the same run conflicts", async () => {
  const started = await start(agentId);
  await claim("m1", started.runId);

  const error = await rejection(claim("m1", started.runId));

  expect(error.code).toBe("conflict");
});

test("two runs of one agent: the first claim wins and the second conflicts", async () => {
  const first = await start(agentId, "a");
  const second = await start(agentId, "b");

  const results = await Promise.allSettled([
    claim("m1", first.runId),
    claim("m1", second.runId),
  ]);

  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
});

test("a newer run of a session waits for the older one", async () => {
  const older = await start(agentId, "s");
  const newer = await start(agentId, "s");

  const error = await rejection(claim("m1", newer.runId));

  expect(error.code).toBe("conflict");
  await claim("m1", older.runId);
});

test("a run of an agent on another machine is forbidden", async () => {
  const started = await start(otherAgentId);

  const error = await rejection(claim("m1", started.runId));

  expect(error.code).toBe("forbidden");
  expect(status(started.runId)?.status).toBe("offered");
});

test("a run with pending files cannot be claimed", async () => {
  const started = await start(agentId);
  db.update(runRows)
    .set({ pendingFiles: "[]" })
    .where(eq(runRows.id, started.runId))
    .run();

  const error = await rejection(claim("m1", started.runId));

  expect(error.code).toBe("conflict");
});

test("a heartbeat moves the lease and refuses a run that is not running", async () => {
  const started = await start(agentId);
  await claim("m1", started.runId);

  nowMs += 60_000;
  await runs.heartbeatRun(machine("m1"), started.runId);

  expect(status(started.runId)?.leaseUntil).toBe(
    new Date(nowMs + 90_000).toISOString()
  );
  await runs.completeRun(machine("m1"), started.runId, { status: "done" });
  const error = await rejection(
    runs.heartbeatRun(machine("m1"), started.runId)
  );
  expect(error.code).toBe("conflict");
});

test("only the machine that claimed a run may heartbeat it", async () => {
  const started = await start(agentId);
  await claim("m1", started.runId);

  const error = await rejection(
    runs.heartbeatRun(machine("m2"), started.runId)
  );

  expect(error.code).toBe("forbidden");
});
