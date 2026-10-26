#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The cloud outage check, live. A cloud run streams for about half a minute
// in its Durable Object under `vite dev`. This script kills the dev server
// (and with it the object) for two minutes while the lease reaper keeps
// sweeping, then starts the server again. The run must still end `done`, and
// a tool call after the restart must succeed.
//
// The script owns the dev server. It starts `bunx vite dev` in apps/web in its
// own process group and kills that group and nothing else. The Durable Object
// reaches the Worker's own /mcp at PUBLIC_BASE_URL, and the Worker reads that
// only from apps/web/.env.local (the wrangler.jsonc value wins over the
// process environment), so put this line there first:
//   PUBLIC_BASE_URL=http://localhost:3917
// Run from the repo root:
//   bun scripts/e2e/cloud-outage.ts [--port 3917] [--log-dir <dir>]
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { sqliteAtomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import { createRequestsService } from "@repo/services/requests";
import { createRunsService } from "@repo/services/runs";
import {
  type RunSummary,
  type RuntimeAdapter,
  systemClock,
  TERMINAL_STATUSES,
} from "@repo/services/runs/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { type Subprocess, sleep, spawn } from "bun";
import {
  devUserPrincipal,
  ENV_FILE,
  LocalError,
  localEvents,
  memoryBlobs,
  openLocalDatabase,
  openSqlite,
  requireOrgId,
  runCli,
  WEB_DIR,
} from "../dev/local.ts";
import { CloudError, type SeqEvent, seqEventsOf } from "./cloud.ts";

const DEFAULT_PORT = 3917;
const DEFAULT_LOG_DIR = join(tmpdir(), "cloud-outage");
const AGENT_MODEL = "faux";
const PROMPT = "slow-bash echo after-the-outage";
const RESULT_MARK = "after-the-outage";
const MID_STREAM_MS = 6000;
const OUTAGE_MS = 120_000;
const OUTAGE_STEP_MS = 20_000;
const START_TIMEOUT_MS = 60_000;
const FINISH_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 120_000;
const PORT_TIMEOUT_MS = 30_000;
const POLL_MS = 1000;
const MS_PER_SECOND = 1000;

export type RunStatus = RunSummary["status"];

/** What the script reads about a run: its status, lease and final text. */
export interface RunState {
  error: string | null;
  leaseUntil: string | null;
  resultText: string | null;
  status: RunStatus;
}

export interface OutageDeps {
  /** Answers a pending request as the dev user, through the requests service. */
  answer: (requestId: string, decision: "allow_once" | "deny") => Promise<void>;
  drive: (action: string, runId: string) => Promise<void>;
  /** The run's events, with their seqs. */
  eventsOf: (runId: string) => SeqEvent[];
  /** The types of all the run's events, also the platform's own, such as `run.waiting`, which carry no seq. */
  eventTypesOf: (runId: string) => string[];
  killServer: () => Promise<void>;
  now: () => Date;
  out: (line: string) => void;
  /** The id of the run's pending request, or undefined when it has none. */
  pendingRequestId: (runId: string) => string | undefined;
  /** One lease sweep. Resolves with the ids of the runs it interrupted. */
  reap: () => Promise<string[]>;
  /** The run's status, lease and final text, as they are now. */
  runOf: (runId: string) => Promise<RunState>;
  /** Starts a run in the e2e session and leaves it queued. Returns the run id. */
  send: (text: string) => Promise<string>;
  /** Sets the agent's tool rule for a tool key. */
  setRule: (toolKey: string, mode: "ask" | "allow") => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  startServer: () => Promise<void>;
}

export const isTerminal = (status: RunStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export const describeError = (state: RunState): string =>
  state.error ? ` (${state.error})` : "";

/** Polls until the run is running and holds a lease. */
export const waitUntilRunning = async (deps: OutageDeps, runId: string) => {
  const deadline = deps.now().getTime() + START_TIMEOUT_MS;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    const state = await deps.runOf(runId);
    if (state.status === "running" && state.leaseUntil !== null) {
      return;
    }
    if (isTerminal(state.status) || deps.now().getTime() > deadline) {
      throw new CloudError(
        `before the outage: run ${runId} is ${state.status}${describeError(state)}, expected running with a lease`
      );
    }
    await deps.sleep(POLL_MS);
  }
};

/** Polls until the run ends or the wait runs out. Also returns the largest lease seen. */
export const waitForEnd = async (
  deps: OutageDeps,
  runId: string
): Promise<{ largestLease: number | null; state: RunState }> => {
  const deadline = deps.now().getTime() + FINISH_TIMEOUT_MS;
  let largestLease: number | null = null;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    const state = await deps.runOf(runId);
    if (state.leaseUntil !== null) {
      const lease = Date.parse(state.leaseUntil);
      largestLease =
        largestLease === null ? lease : Math.max(largestLease, lease);
    }
    if (isTerminal(state.status) || deps.now().getTime() > deadline) {
      return { largestLease, state };
    }
    await deps.sleep(POLL_MS);
  }
};

/** Runs the outage scenario. Throws a CloudError naming the first assertion that fails. */
export const runOutage = async (deps: OutageDeps): Promise<void> => {
  const runId = await deps.send(PROMPT);
  await deps.drive("offer", runId);
  await waitUntilRunning(deps, runId);
  await deps.sleep(MID_STREAM_MS);

  const before = await deps.runOf(runId);
  if (before.status !== "running" || before.leaseUntil === null) {
    throw new CloudError(
      `before the outage: run ${runId} is ${before.status}${describeError(before)}, expected it still running with a lease`
    );
  }
  const leaseBefore = Date.parse(before.leaseUntil);
  deps.out("ok 1: the run is streaming with a lease before the outage");

  await deps.killServer();
  // Events the run writes after the restart carry a larger seq than this.
  const seqAtKill = Math.max(0, ...deps.eventsOf(runId).map((e) => e.seq));

  for (
    let elapsed = OUTAGE_STEP_MS;
    elapsed <= OUTAGE_MS;
    elapsed += OUTAGE_STEP_MS
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep follows the clock
    await deps.sleep(OUTAGE_STEP_MS);
    const interrupted = await deps.reap();
    const seconds = elapsed / MS_PER_SECOND;
    if (interrupted.includes(runId)) {
      throw new CloudError(
        `during the outage: the lease reaper interrupted run ${runId} ${seconds} s in`
      );
    }
    const during = await deps.runOf(runId);
    if (during.status !== "running") {
      throw new CloudError(
        `during the outage (${seconds} s): run ${runId} is ${during.status}, expected running`
      );
    }
    if (
      during.leaseUntil === null ||
      Date.parse(during.leaseUntil) <= deps.now().getTime()
    ) {
      throw new CloudError(
        `during the outage (${seconds} s): run ${runId} lease ${during.leaseUntil} is not in the future`
      );
    }
  }
  deps.out(
    `ok 2: the lease reaper leaves the run running through the ${OUTAGE_MS / MS_PER_SECOND} s outage`
  );

  await deps.startServer();
  const { largestLease, state } = await waitForEnd(deps, runId);
  if (state.status !== "done") {
    throw new CloudError(
      `after the restart: run ${runId} is ${state.status}${describeError(state)}, expected done`
    );
  }
  if (!state.resultText?.includes(RESULT_MARK)) {
    throw new CloudError(
      `after the restart: expected the result to contain ${RESULT_MARK}, got ${JSON.stringify(state.resultText)}`
    );
  }
  deps.out("ok 3: the run ends done after the restart with its result");

  const toolResults = deps
    .eventsOf(runId)
    .filter((event) => event.type === "tool.result" && event.seq > seqAtKill);
  if (toolResults.length === 0) {
    throw new CloudError(
      `after the restart: run ${runId} has no tool.result event`
    );
  }
  for (const event of toolResults) {
    // `ok` in a tool.result payload is `!isError` of the tool result
    // (pi-run-events.ts), so anything but true means the call failed.
    if (event.payload.ok !== true) {
      throw new CloudError(
        `after the restart: the tool call failed: ${JSON.stringify(event.payload.output)}`
      );
    }
  }
  deps.out("ok 4: a tool call after the restart succeeds");

  if (largestLease === null || largestLease <= leaseBefore) {
    const seen =
      largestLease === null ? "no lease" : new Date(largestLease).toISOString();
    throw new CloudError(
      `after the restart: the lease did not move past ${before.leaseUntil}, the largest seen was ${seen}`
    );
  }
  deps.out("ok 5: the lease moves forward after the restart");
};

/** The dev server's origin for a port. */
const originOf = (port: number): string => `http://localhost:${port}`;

/**
 * A `vite dev` server this script starts and stops. It runs in its own process
 * group, and `kill` signals only that group.
 */
const devServer = (port: number, logDir: string) => {
  const origin = originOf(port);
  const logFile = join(logDir, "vite.log");
  let child: Subprocess | undefined;
  let logFd: number | undefined;

  const answers = (): Promise<boolean> =>
    fetch(`${origin}/`).then(
      () => true,
      () => false
    );

  const waitFor = async (
    label: string,
    timeoutMs: number,
    done: () => Promise<boolean>
  ) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
      if (await done()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new CloudError(`${label} timed out. See ${logFile}`);
      }
      await sleep(POLL_MS);
    }
  };

  const start = async () => {
    if (await answers()) {
      throw new LocalError(
        `${origin} already answers. Stop the process on that port first, this script stops only the server it starts.`
      );
    }
    mkdirSync(logDir, { recursive: true });
    logFd = openSync(logFile, "a");
    const proc = spawn(
      ["bunx", "vite", "dev", "--port", String(port), "--strictPort"],
      {
        cwd: WEB_DIR,
        detached: true,
        stderr: logFd,
        stdout: logFd,
      }
    );
    child = proc;
    await waitFor("the dev server start", SERVER_TIMEOUT_MS, () => {
      if (proc.exitCode !== null) {
        throw new CloudError(
          `vite dev exited with ${proc.exitCode}. See ${logFile}`
        );
      }
      return answers();
    });
  };

  const kill = async () => {
    const proc = child;
    if (proc === undefined) {
      return;
    }
    child = undefined;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The group already exited on its own.
    }
    await proc.exited;
    await waitFor(
      "the port going down",
      PORT_TIMEOUT_MS,
      async () => !(await answers())
    );
    if (logFd !== undefined) {
      closeSync(logFd);
      logFd = undefined;
    }
  };

  return { kill, start };
};

/** The Worker must call its own origin, and it reads that from .env.local only. */
const requireBaseUrl = (origin: string) => {
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  if (!lines.some((line) => line.trim() === `PUBLIC_BASE_URL=${origin}`)) {
    throw new LocalError(
      `Add PUBLIC_BASE_URL=${origin} to ${ENV_FILE}, so the Durable Object reaches /mcp on this dev server.`
    );
  }
};

/** Applies the local D1 migrations with wrangler, once. */
const migrate = async (logDir: string) => {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "migrate.log");
  const log = openSync(logFile, "a");
  try {
    const proc = spawn(
      ["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local"],
      { cwd: WEB_DIR, stderr: log, stdout: log }
    );
    if ((await proc.exited) !== 0) {
      throw new LocalError(
        `wrangler d1 migrations apply failed. See ${logFile}`
      );
    }
  } finally {
    closeSync(log);
  }
};

/** Takes a run in and leaves it queued: the dev server dispatches it. */
const holdingCloudAdapter: RuntimeAdapter = {
  cancel: () => Promise.resolve(),
  dispatch: () => Promise.resolve(),
  kind: "cloud",
};

/** The dev server's port and where its logs go. */
export interface HarnessOptions {
  /** Name of the agent the harness creates, to tell the scripts apart in the dev database. */
  agentName: string;
  logDir: string;
  port: number;
}

/** Reads `--port` and `--log-dir`. */
export const parseHarnessArgs = (
  argv: string[],
  agentName: string
): HarnessOptions => {
  const { values } = parseArgs({
    args: argv,
    options: {
      "log-dir": { type: "string" },
      port: { type: "string" },
    },
    strict: true,
  });
  const port = Number(values.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LocalError(`--port must be a port number, got ${values.port}`);
  }
  return { agentName, logDir: values["log-dir"] ?? DEFAULT_LOG_DIR, port };
};

/**
 * Starts the dev server, makes a cloud faux agent in the local database and
 * hands `body` the deps it needs to drive runs and take the server down. The
 * server stops when `body` ends.
 */
export const withHarness = async (
  options: HarnessOptions,
  body: (deps: OutageDeps) => Promise<void>
): Promise<void> => {
  const { agentName, logDir, port } = options;
  const orgId = requireOrgId();
  requireBaseUrl(originOf(port));
  const server = devServer(port, logDir);
  try {
    await migrate(logDir);
    await server.start();
    const local = openLocalDatabase();
    const client = openSqlite(local.file);
    const { db } = local;
    try {
      const principal = await devUserPrincipal(db, orgId);
      const atomic = sqliteAtomic(db as Database);
      const runs = createRunsService({
        adapters: [holdingCloudAdapter],
        atomic,
        blobs: memoryBlobs(),
        clock: systemClock,
        db,
        devFakeRuntime: false,
        gateways: [],
      });
      const slug = `${agentName.toLowerCase().replaceAll(" ", "-")}-${Date.now()}`;
      const agent = await createAgentsService({
        db,
        events: localEvents(db),
      }).create(principal, {
        instructions: "Answer from the script.",
        model: AGENT_MODEL,
        name: agentName,
        runtime: "cloud",
        slug,
      });
      process.stdout.write(`agent ${agent.id}\n`);
      const requests = createRequestsService({
        atomic,
        clock: systemClock,
        db,
        events: localEvents(db),
        runs,
        secrets: { maskerFor: () => Promise.resolve(null) },
      });
      const sessionKey = `e2e-${slug}`;
      await body({
        answer: async (requestId, decision) => {
          await requests.answer(principal, {
            answer: { decision },
            requestId,
            via: "web",
          });
        },
        drive: async (action, runId) => {
          const response = await fetch(
            `${originOf(port)}/api/dev/cloud/${action}`,
            {
              body: JSON.stringify({ runId }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }
          );
          if (!response.ok) {
            throw new CloudError(
              `${action} answered ${response.status}. Is the dev server running?`
            );
          }
        },
        eventsOf: (runId) => seqEventsOf(client, runId),
        eventTypesOf: (runId) =>
          client
            .query<{ type: string }, [string]>(
              "SELECT type FROM events WHERE run_id = ? ORDER BY id"
            )
            .all(runId)
            .map((row) => row.type),
        killServer: server.kill,
        now: () => systemClock.now(),
        out: (line) => process.stdout.write(`${line}\n`),
        pendingRequestId: (runId) =>
          client
            .query<{ id: string }, [string]>(
              "SELECT id FROM run_requests WHERE run_id = ? AND status = 'pending' LIMIT 1"
            )
            .get(runId)?.id,
        reap: async () =>
          (await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).interrupted,
        runOf: async (runId) => {
          const summary = await runs.getRun(principal, runId);
          const row = client
            .query<{ leaseUntil: string | null }, [string]>(
              "SELECT lease_until AS leaseUntil FROM runs WHERE id = ?"
            )
            .get(runId);
          return {
            error: summary.error,
            leaseUntil: row?.leaseUntil ?? null,
            resultText: summary.resultText,
            status: summary.status,
          };
        },
        send: async (text) => {
          const { runId } = await runs.startRun(principal, {
            agentId: agent.id,
            input: { text },
            session: { externalKey: sessionKey, origin: "ui" },
          });
          return runId;
        },
        setRule: (toolKey, mode) =>
          requests.setRule(principal, { agentId: agent.id, mode, toolKey }),
        sleep: (ms) => systemClock.sleep(ms),
        startServer: server.start,
      });
    } finally {
      client.close();
      local.close();
    }
  } finally {
    await server.kill();
  }
};

export const main = async (argv: string[]): Promise<void> => {
  await withHarness(parseHarnessArgs(argv, "Cloud outage faux"), runOutage);
  process.stdout.write("cloud outage check passed\n");
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
