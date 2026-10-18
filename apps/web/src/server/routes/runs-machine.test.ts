import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { migrated } from "@repo/db/test-db";
import {
  claimResponseSchema,
  DAEMON_FEATURES_HEADER,
  FEATURE_LIBRARY_SYNC,
} from "@repo/protocol/machine";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { importRunTokenKey } from "@repo/services/run-tokens";
import type { Clock } from "@repo/services/runs/types";
import {
  createPrincipalResolver,
  type Principal,
  SYSTEM_PRINCIPAL,
} from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { machineRoutes } from "./machines.ts";

const ORG = "org_a";
const ALLOWED_ORG_IDS = [ORG];
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const LEASE_MS = 90_000;
const STEP_MS = 60_000;
const RUN_ROUTES = "/api/machines/runs";

type Action = "claim" | "events" | "heartbeat" | "complete";
const ACTIONS: readonly Action[] = ["claim", "events", "heartbeat", "complete"];

const ONE_EVENT = {
  events: [{ payload: { text: "hi" }, seq: 1, type: "message.assistant" }],
};
const DONE = {
  status: "done",
  text: "hi",
  usage: { inputTokens: 1, outputTokens: 2 },
};

let db: ReturnType<typeof migrated>;
let composed: Composed;
let nowMs: number;
let workspaceId: string;
let user: Extract<Principal, { kind: "user" }>;

/** A mutable test clock. It starts at the real time and only moves forward. */
const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: async () => {
    // The tests never wait on real time.
  },
};

const advance = (ms: number) => {
  nowMs += ms;
};

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock,
    devFakeRuntime: false,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    runTokenKey: KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/api/machines", machineRoutes());

beforeEach(async () => {
  db = migrated();
  nowMs = Date.now();
  composed = composeWith({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    infra: infra(),
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error(`${ORG} is not an allowed organisation`);
  }
  workspaceId = workspace.id;
  user = { kind: "user", userId: "user_1", via: "session", workspaceId };
});

/** Enrols a machine and returns its credential and id. */
const enrol = async (name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(user, {
    machineName: name,
  });
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled;
};

/** An agent that runs on `machineId`. */
const agentOn = async (machineId: string, name: string) =>
  (
    await composed.services.agents.create(user, {
      machineId,
      model: "m",
      name,
      runtime: "machine",
    })
  ).id;

/** Starts a run. Each start moves the clock a second on, so runs order by creation. */
const start = (agentId: string, externalKey?: string) => {
  advance(1000);
  return composed.services.runs.startRun(user, {
    agentId,
    input: { text: "hi" },
    session: { externalKey, origin: "ui" },
  });
};

const row = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const reap = () => composed.services.runs.reapExpiredLeases(SYSTEM_PRINCIPAL);

/** Calls one run route. A null credential sends no Authorization header. */
const call = (
  action: Action,
  runId: string,
  credential: string | null,
  body: unknown = {},
  extraHeaders: Record<string, string> = {}
) =>
  app.request(`${RUN_ROUTES}/${runId}/${action}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...extraHeaders,
      "content-type": "application/json",
    },
    method: "POST",
  });

/** A claim from a daemon that reads the library part of it, as the daemon of W.8 does. */
const claim = (credential: string, runId: string) =>
  call(
    "claim",
    runId,
    credential,
    {},
    {
      [DAEMON_FEATURES_HEADER]: FEATURE_LIBRARY_SYNC,
    }
  );

/** A claim from a daemon built before W.8: it sends no feature header. */
const oldDaemonClaim = (credential: string, runId: string) =>
  call("claim", runId, credential);

test("a run goes offered, running, then done through the four routes", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  expect(row(started.runId)?.status).toBe("offered");

  const claimed = await claim(credential, started.runId);
  expect(claimed.status).toBe(200);
  const body = claimResponseSchema.parse(await claimed.json());
  expect(body.run.id).toBe(started.runId);
  expect(body.run.workspaceId).toBe(workspaceId);
  // The claim names the agent's library folder, with no conflict copies yet.
  expect(body.library).toEqual({
    conflicts: [],
    paths: [`agents/${body.agent.slug}`],
  });
  expect(row(started.runId)?.status).toBe("running");

  const stored = await call("events", started.runId, credential, ONE_EVENT);
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({ lastSeq: 1 });

  const beat = await call("heartbeat", started.runId, credential);
  expect(beat.status).toBe(200);
  expect(await beat.json()).toEqual({});

  const completed = await call("complete", started.runId, credential, DONE);
  expect(completed.status).toBe(200);
  const finished = row(started.runId);
  expect(finished?.status).toBe("done");
  expect(finished?.resultText).toBe("hi");
});

test("a claim for a daemon built before W.8 has no library key, so its strict schema still parses it", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);

  const claimed = await oldDaemonClaim(credential, started.runId);

  expect(claimed.status).toBe(200);
  const json = (await claimed.json()) as Record<string, unknown>;
  // Exactly the keys an older daemon's strict schema knows.
  expect(Object.keys(json).sort()).toEqual([
    "agent",
    "inputFileIds",
    "instructions",
    "mcpServers",
    "run",
    "runToken",
    "session",
  ]);
  expect(row(started.runId)?.status).toBe("running");
});

test("a second claim of the same run answers 409", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  expect((await claim(credential, started.runId)).status).toBe(200);

  const again = await claim(credential, started.runId);

  expect(again.status).toBe(409);
});

test("two queued runs of one agent: concurrent claims give one 200 and one 409", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const first = await start(agentId, "a");
  const second = await start(agentId, "b");

  const responses = await Promise.all([
    claim(credential, first.runId),
    claim(credential, second.runId),
  ]);

  expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
  const statuses = [row(first.runId), row(second.runId)].map(
    (found) => found?.status
  );
  expect(statuses.sort()).toEqual(["offered", "running"]);
});

test("a newer run waits for the older run of its session, and the agent runs one at a time", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const older = await start(agentId, "s");
  const newer = await start(agentId, "s");

  expect((await claim(credential, newer.runId)).status).toBe(409);
  expect((await claim(credential, older.runId)).status).toBe(200);
  expect((await claim(credential, newer.runId)).status).toBe(409);

  const completed = await call("complete", older.runId, credential, DONE);
  expect(completed.status).toBe(200);
  expect((await claim(credential, newer.runId)).status).toBe(200);
});

test("a machine that does not own the run's agent gets 403 and the row is unchanged", async () => {
  const owner = await enrol("laptop");
  const other = await enrol("desk");
  const agentId = await agentOn(owner.machineId, "Box");
  const started = await start(agentId);

  const res = await claim(other.credential, started.runId);

  expect(res.status).toBe(403);
  const unchanged = row(started.runId);
  expect(unchanged?.status).toBe("offered");
  expect(unchanged?.claimedBy).toBeNull();
});

test("a run with pending files cannot be claimed", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  db.update(runRows)
    .set({ pendingFiles: "[]" })
    .where(eq(runRows.id, started.runId))
    .run();

  const res = await claim(credential, started.runId);

  expect(res.status).toBe(409);
  expect(row(started.runId)?.status).toBe("offered");
});

test("a run token resolves while heartbeats keep the lease, and stops once the lease is reaped", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  const claimed = claimResponseSchema.parse(
    await (await claim(credential, started.runId)).json()
  );
  const resolver = createPrincipalResolver({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    isOrgMember: () => Promise.resolve(false),
    runTokenKey: await importRunTokenKey(KEY),
    verifyClerkOAuthToken: () => Promise.resolve(null),
  });
  const resolve = () => resolver.resolve(`Bearer ${claimed.runToken}`);
  const runPrincipal: Principal = {
    agentId,
    kind: "run",
    runId: started.runId,
    workspaceId,
  };
  expect(await resolve()).toEqual(runPrincipal);

  // Three lease periods in steps of at most 60 s, with a heartbeat before each step ends.
  for (let left = 3 * LEASE_MS; left > 0; left -= STEP_MS) {
    advance(Math.min(STEP_MS, left));
    // biome-ignore lint/performance/noAwaitInLoops: each heartbeat must land before the next step
    const beat = await call("heartbeat", started.runId, credential);
    expect(beat.status).toBe(200);
    expect(await resolve()).toEqual(runPrincipal);
  }

  // Let the lease pass without a heartbeat, then reap it.
  advance(LEASE_MS + 1000);
  const reaped = await reap();
  expect(reaped.interrupted).toEqual([started.runId]);
  expect(row(started.runId)?.status).toBe("interrupted");
  expect(await resolve()).toBeNull();
});

test("an expired lease interrupts the run, and the run then refuses every write but an aborted completion", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  expect((await claim(credential, started.runId)).status).toBe(200);

  advance(LEASE_MS + 1000);
  const reaped = await reap();
  expect(reaped.interrupted).toEqual([started.runId]);
  expect(row(started.runId)?.status).toBe("interrupted");

  expect(
    (await call("events", started.runId, credential, ONE_EVENT)).status
  ).toBe(409);
  expect((await call("complete", started.runId, credential, DONE)).status).toBe(
    409
  );
  expect((await call("heartbeat", started.runId, credential)).status).toBe(409);

  const aborted = await call("complete", started.runId, credential, {
    status: "aborted",
  });
  expect(aborted.status).toBe(200);
  expect(row(started.runId)?.processEndedAt).not.toBeNull();

  const again = await call("complete", started.runId, credential, {
    status: "aborted",
  });
  expect(again.status).toBe(409);
});

test("an aborted completion of a running run drops the run token and frees the agent's next run", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const first = await start(agentId, "a");
  const next = await start(agentId, "b");
  const claimed = claimResponseSchema.parse(
    await (await claim(credential, first.runId)).json()
  );
  const resolver = createPrincipalResolver({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    isOrgMember: () => Promise.resolve(false),
    runTokenKey: await importRunTokenKey(KEY),
    verifyClerkOAuthToken: () => Promise.resolve(null),
  });
  const resolve = () => resolver.resolve(`Bearer ${claimed.runToken}`);
  expect(await resolve()).not.toBeNull();
  expect((await claim(credential, next.runId)).status).toBe(409);

  const aborted = await call("complete", first.runId, credential, {
    status: "aborted",
  });

  expect(aborted.status).toBe(200);
  expect(row(first.runId)).toMatchObject({ status: "interrupted" });
  expect(row(first.runId)?.processEndedAt).not.toBeNull();
  expect(await resolve()).toBeNull();
  expect((await claim(credential, next.runId)).status).toBe(200);
});

test("each run route answers 401 without an Authorization header", async () => {
  const { machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  const bodies: Record<Action, unknown> = {
    claim: {},
    complete: DONE,
    events: ONE_EVENT,
    heartbeat: {},
  };

  const responses = await Promise.all(
    ACTIONS.map((action) => call(action, started.runId, null, bodies[action]))
  );

  expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 401]);
  expect(row(started.runId)?.status).toBe("offered");
});

test("a malformed events body answers 400 and stores nothing", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agentId = await agentOn(machineId, "Box");
  const started = await start(agentId);
  expect((await claim(credential, started.runId)).status).toBe(200);

  const bodies: unknown[] = [
    "not json",
    { events: "nope" },
    { events: [{ payload: {}, seq: 0, type: "message.assistant" }] },
  ];
  for (const body of bodies) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the order obvious
    const res = await call("events", started.runId, credential, body);
    expect(res.status).toBe(400);
  }
  expect(row(started.runId)?.status).toBe("running");
});

test("a machine that did not claim the run gets 403 on events, heartbeat and complete", async () => {
  const owner = await enrol("laptop");
  const other = await enrol("desk");
  const agentId = await agentOn(owner.machineId, "Box");
  const started = await start(agentId);
  expect((await claim(owner.credential, started.runId)).status).toBe(200);

  expect(
    (await call("events", started.runId, other.credential, ONE_EVENT)).status
  ).toBe(403);
  expect(
    (await call("heartbeat", started.runId, other.credential)).status
  ).toBe(403);
  expect(
    (await call("complete", started.runId, other.credential, DONE)).status
  ).toBe(403);

  const still = row(started.runId);
  expect(still?.status).toBe("running");
  expect(still?.claimedBy).toBe(owner.machineId);
});
