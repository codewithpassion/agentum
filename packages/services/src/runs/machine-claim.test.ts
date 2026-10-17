import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  agentConnectors as agentConnectorRows,
  connectors as connectorRows,
} from "@repo/db/schema/connectors";
import { events as eventRows } from "@repo/db/schema/events";
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
import { createSecretsService, type SecretsService } from "../secrets.ts";
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
let secrets: SecretsService;
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

const addConnector = (id: string, name: string) => {
  db.insert(connectorRows)
    .values({
      authKind: "none",
      createdAt: START,
      createdBy: "u1",
      id,
      name,
      status: "ok",
      url: `https://${id}.example/mcp`,
      workspaceId: WORKSPACE,
    })
    .run();
};

const assign = (agent: string, connectorId: string, createdAt: string) => {
  db.insert(agentConnectorRows)
    .values({ agentId: agent, connectorId, createdAt, workspaceId: WORKSPACE })
    .run();
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
  const events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  secrets = createSecretsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    secretsKey: KEY,
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
    secrets,
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

test("a claim adds a proxy entry for each connector the agent has", async () => {
  addConnector("c-github", "GitHub");
  addConnector("c-linear", "Linear");
  assign(agentId, "c-linear", "2026-10-16T10:00:01.000Z");
  assign(agentId, "c-github", "2026-10-16T10:00:02.000Z");
  const started = await start(agentId);

  const claimed = await claim("m1", started.runId);

  expect(Object.keys(claimed.mcpServers)).toEqual([
    "harbourmaster",
    "linear",
    "github",
  ]);
  const headers = { Authorization: `Bearer ${claimed.runToken}` };
  expect(claimed.mcpServers.linear).toEqual({
    headers,
    type: "http",
    url: "https://hm.example/api/proxy/c-linear",
  });
  expect(claimed.mcpServers.github).toEqual({
    headers,
    type: "http",
    url: "https://hm.example/api/proxy/c-github",
  });
});

test("a connector assigned to another agent is not in the claim", async () => {
  addConnector("c-mine", "Mine");
  addConnector("c-theirs", "Theirs");
  assign(agentId, "c-mine", START);
  assign(otherAgentId, "c-theirs", START);
  const started = await start(agentId);

  const claimed = await claim("m1", started.runId);

  expect(Object.keys(claimed.mcpServers)).toEqual(["harbourmaster", "mine"]);
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

test("the claiming machine's aborted completion interrupts a running run", async () => {
  const started = await start(agentId);
  await claim("m1", started.runId);

  nowMs += 5000;
  await runs.completeRun(machine("m1"), started.runId, { status: "aborted" });

  const endedAt = new Date(nowMs).toISOString();
  expect(status(started.runId)).toMatchObject({
    error: "Aborted by the machine",
    finishedAt: endedAt,
    processEndedAt: endedAt,
    status: "interrupted",
  });
  const interrupted = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.runId, started.runId))
    .all()
    .filter((event) => event.type === "run.interrupted");
  expect(interrupted).toHaveLength(1);

  const repeated = await rejection(
    runs.completeRun(machine("m1"), started.runId, { status: "aborted" })
  );
  expect(repeated.code).toBe("conflict");
});

test("another machine's aborted completion is forbidden and leaves the run running", async () => {
  const started = await start(agentId);
  await claim("m1", started.runId);

  const error = await rejection(
    runs.completeRun(machine("m2"), started.runId, { status: "aborted" })
  );

  expect(error.code).toBe("forbidden");
  expect(status(started.runId)).toMatchObject({
    processEndedAt: null,
    status: "running",
  });
});

const ENV_VALUE = "env-secret-value-0123";
const PROXY_VALUE = "proxy-secret-value-0123";

/** An env secret and a proxy secret, both granted to `agent`. */
const grantBoth = async (agent: string) => {
  const env = await secrets.create(user, {
    mode: "env",
    name: "PLAIN_KEY",
    value: ENV_VALUE,
  });
  const proxied = await secrets.create(user, {
    mode: "proxy",
    name: "OPENAI_API_KEY",
    rules: [
      {
        header: "Authorization",
        host: "api.openai.com",
        template: "Bearer {value}",
      },
    ],
    value: PROXY_VALUE,
  });
  await secrets.setGrants(user, agent, [env.id, proxied.id]);
};

test("a claim carries the agent's env secrets, the relay token and the relay guidance", async () => {
  await grantBoth(agentId);
  const started = await start(agentId);

  const claimed = await claim("m1", started.runId);

  expect(claimed.env).toEqual({
    HARBOURMASTER_RELAY_TOKEN: claimed.runToken,
    PLAIN_KEY: ENV_VALUE,
  });
  expect(claimed.instructions.startsWith("Be brief.")).toBe(true);
  expect(claimed.instructions).toContain("PLAIN_KEY");
  expect(claimed.instructions).toContain(
    "https://hm.example/api/egress/api.openai.com/<path>"
  );
  expect(claimed.instructions).not.toContain(PROXY_VALUE);
  expect(claimed.instructions).not.toContain(ENV_VALUE);
  // The proxy secret itself never goes to the machine.
  expect(JSON.stringify(claimed)).not.toContain(PROXY_VALUE);
});

test("a claim announces the delivery with names and hosts only", async () => {
  await grantBoth(agentId);
  const started = await start(agentId);
  await claim("m1", started.runId);

  const delivered = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "secret.delivered"))
    .all();
  expect(delivered).toHaveLength(1);
  const text = JSON.stringify(delivered);
  expect(text).toContain("PLAIN_KEY");
  expect(text).toContain("api.openai.com");
  expect(text).not.toContain(ENV_VALUE);
  expect(text).not.toContain(PROXY_VALUE);
});

test("an agent with a proxy secret only gets the relay token, and one with no grant gets nothing", async () => {
  const proxied = await secrets.create(user, {
    mode: "proxy",
    name: "OPENAI_API_KEY",
    rules: [
      { header: "x-api-key", host: "api.openai.com", template: "{value}" },
    ],
    value: PROXY_VALUE,
  });
  await secrets.setGrants(user, agentId, [proxied.id]);

  const granted = await claim("m1", (await start(agentId)).runId);
  expect(Object.keys(granted.env ?? {})).toEqual(["HARBOURMASTER_RELAY_TOKEN"]);

  const bare = await claim("m2", (await start(otherAgentId)).runId);
  expect(bare.env).toBeUndefined();
  expect(bare.instructions).toBe("");
  expect(
    db
      .select()
      .from(eventRows)
      .where(eq(eventRows.agentId, otherAgentId))
      .all()
      .some((event) => event.type === "secret.delivered")
  ).toBe(false);
});
