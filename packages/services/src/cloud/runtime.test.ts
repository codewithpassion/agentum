import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "../agents.ts";
import { seedAssignment, seedConnector } from "../connectors/test-seed.ts";
import { createEventsService } from "../events.ts";
import { importRunTokenKey, verifyRunToken } from "../run-tokens.ts";
import type { Clock, StartRunInput } from "../runs/types.ts";
import {
  createRunsService,
  type RunsService,
  STALE_QUEUE_MS,
} from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { CLOUD_LEASE_MS } from "./lease.ts";
import { createCloudRuntime } from "./runtime.ts";
import type { CloudRunnerPort, CloudStart } from "./types.ts";

const WORKSPACE = "w1";
const START = "2026-10-17T10:00:00.000Z";
const BASE = "https://hm.example";
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const SECOND = 1000;

const dom: Principal = {
  kind: "user",
  userId: "user_dom",
  via: "slack",
  workspaceId: WORKSPACE,
};

/** Records every call. A failure set on it is thrown after the call is recorded. */
class FakeRunner implements CloudRunnerPort {
  cancelCalls: [string, string][] = [];
  cancelFailure: Error | null = null;
  startCalls: CloudStart[] = [];
  startFailure: Error | null = null;

  cancel(runId: string, sessionId: string) {
    this.cancelCalls.push([runId, sessionId]);
    return this.cancelFailure
      ? Promise.reject(this.cancelFailure)
      : Promise.resolve();
  }

  start(input: CloudStart) {
    this.startCalls.push(input);
    return this.startFailure
      ? Promise.reject(this.startFailure)
      : Promise.resolve();
  }
}

let db: ReturnType<typeof migrated>;
let nowMs: number;
let runner: FakeRunner;
let runs: RunsService;
let agentId: string;
let logged: string[];
let restoreConsole: () => void;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const start = async (
  extra: Partial<StartRunInput> = {},
  options: Parameters<RunsService["startRun"]>[2] = {}
) => {
  nowMs += SECOND;
  return await runs.startRun(
    dom,
    {
      agentId,
      input: { text: "Summarise the inbox" },
      session: { externalKey: "thread-1", origin: "slack" },
      ...extra,
    },
    options
  );
};

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const runEvents = (runId: string) =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.runId, runId))
    .orderBy(asc(eventRows.id))
    .all();

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  runner = new FakeRunner();
  logged = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    }
  );
  restoreConsole = () => spy.mockRestore();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  const blobs = {
    get: (name: string) => Promise.resolve(store.get(name) ?? null),
    put: (name: string, body: string) => {
      store.set(name, body);
      return Promise.resolve();
    },
  };
  const events = createEventsService({ blobs, db });
  const agents: AgentsService = createAgentsService({ db, events });
  agentId = (
    await agents.create(dom, {
      instructions: "Be brief.",
      model: "sonnet",
      name: "Pelican",
      runtime: "cloud",
    })
  ).id;
  runs = createRunsService({
    adapters: [
      createCloudRuntime({
        platformUrl: BASE,
        runner,
        runTokenKey: RUN_TOKEN_KEY,
      }),
    ],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
});

afterEach(() => {
  restoreConsole();
});

describe("dispatch", () => {
  test("claims the run and starts the runner with the run, agent and MCP servers", async () => {
    await seedConnector(db, {
      authKind: "none",
      id: "con_mail",
      name: "Mail Tools",
      now: START,
      workspaceId: WORKSPACE,
    });
    await seedConnector(db, {
      authKind: "none",
      id: "con_docs",
      name: "Docs",
      now: START,
      workspaceId: WORKSPACE,
    });
    await Promise.all(
      ["con_mail", "con_docs"].map((connectorId) =>
        seedAssignment(db, {
          agentId,
          connectorId,
          now: START,
          workspaceId: WORKSPACE,
        })
      )
    );

    const { runId, sessionId } = await start();

    const run = runRow(runId);
    expect(run?.status).toBe("running");
    expect(run?.claimedBy).toBe("system");
    expect(runEvents(runId).map((event) => event.type)).toContain(
      "run.started"
    );
    expect(runner.startCalls).toHaveLength(1);
    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    const servers = input.mcpServers;
    const server = (name: string) => {
      const found = servers[name];
      if (!found) {
        throw new Error(`No ${name} MCP server`);
      }
      return found;
    };
    expect(input.run).toEqual({
      agentId,
      id: runId,
      inputText: "Summarise the inbox",
      sessionId,
      workspaceId: WORKSPACE,
    });
    expect(input.agent).toMatchObject({
      id: agentId,
      instructions: "Be brief.",
      model: "sonnet",
      name: "Pelican",
    });
    expect(input.inputFileIds).toEqual([]);
    // Connectors come in by connectorId when they share a createdAt.
    expect(Object.keys(servers)).toEqual([
      "harbourmaster",
      "docs",
      "mail-tools",
    ]);
    expect(server("harbourmaster").url).toBe(`${BASE}/mcp`);
    expect(server("docs").url).toBe(`${BASE}/api/proxy/con_docs`);
    expect(server("mail-tools").url).toBe(`${BASE}/api/proxy/con_mail`);

    const token = input.runToken;
    expect(token.startsWith("hm_run_")).toBe(true);
    expect(server("harbourmaster").headers).toEqual({
      Authorization: `Bearer ${token}`,
    });
    const verified = await verifyRunToken({
      db,
      key: await importRunTokenKey(RUN_TOKEN_KEY),
      now: clock.now(),
      token,
    });
    expect(verified).toMatchObject({
      claims: { agentId, runId, workspaceId: WORKSPACE },
      ok: true,
    });
  });

  test("claims with the cloud lease, so the run token outlasts an outage of the runner", async () => {
    const { runId } = await start();
    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    const key = await importRunTokenKey(RUN_TOKEN_KEY);
    const tokenAt = (afterMs: number) =>
      verifyRunToken({
        db,
        key,
        now: new Date(nowMs + afterMs),
        token: input.runToken,
      });

    expect(runRow(runId)?.leaseUntil).toBe(
      new Date(nowMs + CLOUD_LEASE_MS).toISOString()
    );
    // No heartbeat for two minutes: the 90 second lease would be over.
    expect((await tokenAt(120 * SECOND)).ok).toBe(true);
    expect((await tokenAt(CLOUD_LEASE_MS + SECOND)).ok).toBe(false);
  });
});

describe("claims", () => {
  test("two dispatches of one queued run start the runner once", async () => {
    const { runId } = await start({}, { offerLater: true });
    expect(runRow(runId)?.status).toBe("queued");

    await Promise.all([
      runs.offerQueuedRun(SYSTEM_PRINCIPAL, runId),
      runs.offerQueuedRun(SYSTEM_PRINCIPAL, runId),
    ]);

    expect(runRow(runId)?.status).toBe("running");
    expect(runner.startCalls.map((call) => call.run.id)).toEqual([runId]);
  });

  test("a second run of the agent waits while the first is running", async () => {
    const first = await start();
    const second = await start({
      session: { externalKey: "thread-2", origin: "slack" },
    });

    expect(runRow(first.runId)?.status).toBe("running");
    expect(runRow(second.runId)?.status).toBe("queued");
    expect(runRow(second.runId)?.claimedBy).toBeNull();
    expect(runner.startCalls.map((call) => call.run.id)).toEqual([first.runId]);
  });

  test("a younger run of a session waits while an older one is queued", async () => {
    const older = await start({}, { offerLater: true });
    const younger = await start();

    expect(runRow(older.runId)?.status).toBe("queued");
    expect(runRow(younger.runId)?.status).toBe("queued");
    expect(runner.startCalls).toEqual([]);
  });
});

describe("a start that fails", () => {
  test("releases the run to offered, logs without the token, and a later sweep starts it", async () => {
    runner.startFailure = new Error("runner unavailable");

    const { runId } = await start();

    expect(runRow(runId)?.status).toBe("offered");
    expect(runRow(runId)?.claimedBy).toBeNull();
    expect(runRow(runId)?.leaseUntil).toBeNull();
    expect(logged.join("\n")).toContain(runId);
    expect(logged.join("\n")).toContain("runner unavailable");
    expect(logged.join("\n")).not.toContain("hm_run_");

    runner.startFailure = null;
    nowMs += STALE_QUEUE_MS + SECOND;
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runRow(runId)?.status).toBe("running");
    expect(runRow(runId)?.claimedBy).toBe("system");
    expect(runner.startCalls.map((call) => call.run.id)).toEqual([
      runId,
      runId,
    ]);
  });
});

describe("cancel", () => {
  test("stops the runner once and marks the run cancelled", async () => {
    const { runId, sessionId } = await start();

    await runs.cancelRun(dom, runId);

    expect(runner.cancelCalls).toEqual([[runId, sessionId]]);
    expect(runRow(runId)?.status).toBe("cancelled");
  });

  test("a runner whose cancel throws does not fail cancelRun", async () => {
    runner.cancelFailure = new Error("runner unreachable");
    const { runId } = await start();

    await runs.cancelRun(dom, runId);

    expect(runRow(runId)?.status).toBe("cancelled");
    expect(logged.join("\n")).toContain(runId);
  });
});
