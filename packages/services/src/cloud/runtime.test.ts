import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { machines as machineRows } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { slackApps } from "@repo/db/schema/slack";
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
import { SLACK_GUIDANCE } from "../slack/guidance.ts";
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

/** Waits for `count` rounds of pending work, each one a macrotask. */
const turns = (count: number): Promise<void> =>
  count <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
        turns(count - 1)
      );

/**
 * Records every call. A failure set on it is thrown after the call is recorded.
 * With `startMode` set to "hangs", `start` never returns, like a runner that
 * hangs while the request that woke it is cancelled.
 */
class FakeRunner implements CloudRunnerPort {
  cancelCalls: [string, string][] = [];
  cancelFailure: Error | null = null;
  startCalls: CloudStart[] = [];
  startFailure: Error | null = null;
  startMode: "settles" | "hangs" = "settles";

  cancel(runId: string, sessionId: string) {
    this.cancelCalls.push([runId, sessionId]);
    return this.cancelFailure
      ? Promise.reject(this.cancelFailure)
      : Promise.resolve();
  }

  start(input: CloudStart) {
    this.startCalls.push(input);
    if (this.startMode === "hangs") {
      return new Promise<void>(() => undefined);
    }
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

const installSlackApp = (agent: string) => {
  db.insert(slackApps)
    .values({
      agentId: agent,
      appId: "A0SLACK",
      botToken: null,
      botUserId: "U0BOT",
      createdAt: START,
      id: `app-${agent}`,
      signingSecret: "ciphertext",
      status: "installed",
      teamId: "T0TEAM",
      workspaceId: WORKSPACE,
    })
    .run();
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

/** The runner claims a run once it can start it. Tests do that claim here. */
const claimAsRunner = (runId: string) =>
  runs.claimRun(SYSTEM_PRINCIPAL, runId, { leaseMs: CLOUD_LEASE_MS });

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

describe("a request that ends during the start", () => {
  test("a request that dies right after the run is accepted does not strand the run", async () => {
    runner.startMode = "hangs";
    nowMs += SECOND;
    // The request is cancelled while dispatch waits on the runner. Nothing
    // awaits the call.
    runs.startRun(dom, {
      agentId,
      input: { text: "Summarise the inbox" },
      session: { externalKey: "thread-1", origin: "slack" },
    });
    await turns(5);

    const [run] = db
      .select()
      .from(runRows)
      .where(eq(runRows.agentId, agentId))
      .all();
    if (!run) {
      throw new Error("The run was not accepted");
    }
    expect(["queued", "offered"]).toContain(run.status);
    expect(runEvents(run.id).map((event) => event.type)).not.toContain(
      "run.started"
    );
    expect(runner.startCalls).toHaveLength(1);

    nowMs += STALE_QUEUE_MS + SECOND;
    runner.startMode = "settles";
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runner.startCalls.map((call) => call.run.id)).toEqual([
      run.id,
      run.id,
    ]);
  });
});

/** Adds a computer machine and attaches it to the test agent. */
const attachComputer = (
  capabilities: string | null,
  status: "online" | "revoked" = "online"
) => {
  db.insert(machineRows)
    .values({
      capabilities: "{}",
      computerCapabilities: capabilities,
      computerStatus: "online",
      createdAt: START,
      credentialHash: "hash-m1",
      enrolledBy: "user_dom",
      id: "m1",
      lastSeenAt: START,
      name: "Desk",
      singleUser: false,
      status,
      workspaceId: WORKSPACE,
    })
    .run();
  db.update(agentRows)
    .set({ computerMachineId: "m1" })
    .where(eq(agentRows.id, agentId))
    .run();
};

describe("the attached computer", () => {
  test("an agent with no computer gets no computer in the start input", async () => {
    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect("computer" in input).toBe(false);
  });

  test("an attached computer with desktop capability is passed to the runner", async () => {
    attachComputer('{"desktop":true}');

    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.computer).toEqual({ desktop: true, machineId: "m1" });
  });

  test("an attached computer with null capabilities has no desktop", async () => {
    attachComputer(null);

    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.computer).toEqual({ desktop: false, machineId: "m1" });
  });

  test("a revoked computer is not passed to the runner", async () => {
    attachComputer('{"desktop":true}', "revoked");

    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect("computer" in input).toBe(false);
  });
});

describe("dispatch", () => {
  test("the runner gets the Slack line after the instructions when the agent has an installed Slack app", async () => {
    installSlackApp(agentId);

    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.agent.instructions).toBe(`Be brief.\n\n${SLACK_GUIDANCE}`);
  });

  test("a non-dry run gets its own task folder in the library", async () => {
    const { runId } = await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.library?.taskFolder).toBe(`agents/pelican/tasks/${runId}`);
  });

  test("a dry run gets no task folder in the library", async () => {
    await start({}, { dryRun: true });

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.library).toBeDefined();
    expect(input.library && "taskFolder" in input.library).toBe(false);
  });

  test("the runner gets the agent's own instructions when the agent has no Slack app", async () => {
    await start();

    const [input] = runner.startCalls;
    if (!input) {
      throw new Error("The runner was not started");
    }
    expect(input.agent.instructions).toBe("Be brief.");
  });

  test("wakes the runner with the run, agent and MCP servers, and leaves the run for the runner to claim", async () => {
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
    expect(run?.status).toBe("queued");
    expect(run?.claimedBy).toBeNull();
    expect(runEvents(runId).map((event) => event.type)).not.toContain(
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
      dryRun: false,
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
  });

  test("once the runner claims the run with the cloud lease, the run token outlasts an outage of the runner", async () => {
    const { runId } = await start();
    await claimAsRunner(runId);
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

    expect(
      await verifyRunToken({
        db,
        key,
        now: clock.now(),
        token: input.runToken,
      })
    ).toMatchObject({
      claims: { agentId, runId, workspaceId: WORKSPACE },
      ok: true,
    });
    expect(runRow(runId)?.leaseUntil).toBe(
      new Date(nowMs + CLOUD_LEASE_MS).toISOString()
    );
    // No heartbeat for two minutes: the 90 second lease would be over.
    expect((await tokenAt(120 * SECOND)).ok).toBe(true);
    expect((await tokenAt(CLOUD_LEASE_MS + SECOND)).ok).toBe(false);
  });
});

describe("a start that fails", () => {
  test("logs without the token, leaves the run queued, and a later sweep wakes it again", async () => {
    runner.startFailure = new Error("runner unavailable");

    const { runId } = await start();

    expect(runRow(runId)?.status).toBe("queued");
    expect(runRow(runId)?.claimedBy).toBeNull();
    expect(logged.join("\n")).toContain(runId);
    expect(logged.join("\n")).toContain("runner unavailable");
    expect(logged.join("\n")).not.toContain("hm_run_");

    runner.startFailure = null;
    nowMs += STALE_QUEUE_MS + SECOND;
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runRow(runId)?.status).toBe("queued");
    expect(runner.startCalls.map((call) => call.run.id)).toEqual([
      runId,
      runId,
    ]);
  });
});

describe("a dry run", () => {
  test("is handed to the runner with its flag, read from the run row", async () => {
    runner.startFailure = new Error("runner unavailable");
    const { runId } = await start();
    db.update(runRows).set({ dryRun: true }).where(eq(runRows.id, runId)).run();

    runner.startFailure = null;
    nowMs += STALE_QUEUE_MS + SECOND;
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runner.startCalls.map((call) => call.run.dryRun)).toEqual([
      false,
      true,
    ]);
  });
});

describe("the model a run starts on", () => {
  const startedModel = () => {
    const [input] = runner.startCalls.slice(-1);
    if (!input) {
      throw new Error("The runner was not started");
    }
    return input.agent.model;
  };

  test("a dry run on a model that is not a cloud model starts on the default cloud model", async () => {
    db.update(agentRows)
      .set({ model: "not-a-model" })
      .where(eq(agentRows.id, agentId))
      .run();

    await start({}, { dryRun: true });

    expect(startedModel()).toBe("claude-sonnet-5-5");
  });

  test("a dry run on a cloud model alias keeps the model", async () => {
    db.update(agentRows)
      .set({ model: "opus" })
      .where(eq(agentRows.id, agentId))
      .run();

    await start({}, { dryRun: true });

    expect(startedModel()).toBe("opus");
  });

  test("a dry run on a cloud model id keeps the model", async () => {
    db.update(agentRows)
      .set({ model: "claude-opus-5-5" })
      .where(eq(agentRows.id, agentId))
      .run();

    await start({}, { dryRun: true });

    expect(startedModel()).toBe("claude-opus-5-5");
  });

  test("a normal run keeps a model that is not a cloud model", async () => {
    db.update(agentRows)
      .set({ model: "gpt-5" })
      .where(eq(agentRows.id, agentId))
      .run();

    await start();

    expect(startedModel()).toBe("gpt-5");
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

describe("waking the next run when one ends", () => {
  const otherSession = { externalKey: "thread-2", origin: "slack" } as const;

  /** The run ids the runner was woken for while `action` ran. */
  const wokenBy = async (action: () => Promise<unknown>) => {
    const before = runner.startCalls.length;
    await action();
    return runner.startCalls.slice(before).map((call) => call.run.id);
  };

  test("a queued run of the session is woken when the running one is done", async () => {
    const first = await start();
    const second = await start();
    await claimAsRunner(first.runId);

    const woken = await wokenBy(() =>
      runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
        status: "done",
        text: "Done",
      })
    );

    expect(runRow(first.runId)?.status).toBe("done");
    expect(woken).toEqual([second.runId]);
    expect(runRow(second.runId)?.status).toBe("queued");
  });

  test("a queued run of the session is woken when the running one fails", async () => {
    const first = await start();
    const second = await start();
    await claimAsRunner(first.runId);

    const woken = await wokenBy(() =>
      runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
        error: "boom",
        status: "failed",
      })
    );

    expect(runRow(first.runId)?.status).toBe("failed");
    expect(woken).toEqual([second.runId]);
  });

  test("a queued run of the session is woken when the running one is cancelled", async () => {
    const first = await start();
    const second = await start();
    await claimAsRunner(first.runId);

    const woken = await wokenBy(() => runs.cancelRun(dom, first.runId));

    expect(runRow(first.runId)?.status).toBe("cancelled");
    expect(woken).toEqual([second.runId]);
  });

  test("a queued run of another session of the agent is woken when the running one ends", async () => {
    const first = await start();
    const second = await start({ session: otherSession });
    await claimAsRunner(first.runId);

    const woken = await wokenBy(() =>
      runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
        status: "done",
        text: "Done",
      })
    );

    expect(woken).toEqual([second.runId]);
  });

  test("with two waiting runs the oldest is woken first, and the next one after it ends", async () => {
    const first = await start();
    const second = await start();
    const third = await start();
    await claimAsRunner(first.runId);

    const wokenFirst = await wokenBy(() =>
      runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
        status: "done",
        text: "Done",
      })
    );

    expect(wokenFirst).toEqual([second.runId]);

    await claimAsRunner(second.runId);
    const wokenSecond = await wokenBy(() =>
      runs.completeRun(SYSTEM_PRINCIPAL, second.runId, {
        status: "done",
        text: "Done",
      })
    );

    expect(wokenSecond).toEqual([third.runId]);
  });

  test("a failing runner start while waking does not fail completeRun", async () => {
    const first = await start();
    const second = await start();
    await claimAsRunner(first.runId);
    runner.startFailure = new Error("runner unavailable");

    await expect(
      runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
        status: "done",
        text: "Done",
      })
    ).resolves.toBeUndefined();

    expect(runRow(first.runId)?.status).toBe("done");
    expect(runRow(second.runId)?.status).toBe("queued");
    expect(logged.join("\n")).toContain(second.runId);
  });
});

test("dispatch composes voice and hands to before Slack guidance", async () => {
  const agents = createAgentsService({
    db,
    events: createEventsService({
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      db,
    }),
  });
  const target = await agents.create(dom, {
    model: "sonnet",
    name: "Helper",
    runtime: "cloud",
  });
  await agents.update(dom, agentId, {
    handsTo: [target.id],
    soul: "Speak warmly.",
  });
  installSlackApp(agentId);
  await start();
  const [input] = runner.startCalls;
  if (!input) {
    throw new Error("The runner was not started");
  }
  expect(input.agent.instructions).toBe(
    `Be brief.\n\n## Voice\nSpeak warmly.\n\nYou can hand work to: Helper (use send_message)\n\n${SLACK_GUIDANCE}`
  );
});
