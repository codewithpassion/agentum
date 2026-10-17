#!/usr/bin/env bun
import type { Database as Sqlite } from "bun:sqlite";
// The cloud runtime check, live. It needs a dev server on a free port with the
// Worker's own origin in `PUBLIC_BASE_URL` (the Durable Object reaches /mcp
// there), for example:
//   cd apps/web && wrangler d1 migrations apply DB --local \
//     && PUBLIC_BASE_URL=http://localhost:3917 vite dev --port 3917
// The agent's model is `faux`, a scripted model that dev builds load, so no
// API key is used. The script writes agents and runs straight into the local
// D1 database, as scripts/e2e/skeleton.ts does, and asks the dev server to
// dispatch them (POST /api/dev/cloud/offer, redispatch, cancel). Run from the
// repo root: `bun scripts/e2e/cloud.ts [--server <url>]`.
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { sqliteAtomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import { createRunsService } from "@repo/services/runs";
import type { RunSummary, RuntimeAdapter } from "@repo/services/runs/types";
import { systemClock } from "@repo/services/runs/types";
import {
  devUserPrincipal,
  localEvents,
  memoryBlobs,
  openLocalDatabase,
  openSqlite,
  requireOrgId,
  runCli,
} from "../dev/local.ts";

const DEFAULT_SERVER = "http://localhost:3000";
const TRAILING_SLASHES = /\/+$/;
const RUN_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;
const BUSY_MS = 1500;
const AGENT_MODEL = "faux";
const NOTES_PATH = "/library/e2e-env/notes.md";
const NOTES_BEFORE = "alpha beta";
const NOTES_EDIT = { newText: "gamma", oldText: "alpha" };
const NOTES_AFTER = "gamma beta";

export class CloudError extends Error {}

/** The run events of one run that carry a seq. */
export interface SeqEvent {
  payload: Record<string, unknown>;
  seq: number;
  type: string;
}

export interface CloudDeps {
  /** `offer`, `redispatch` or `cancel` for a run, on the dev server. */
  drive: (action: string, runId: string) => Promise<void>;
  /** Rows of `events` that share a run and a seq. */
  duplicateSeqs: (runIds: string[]) => { runId: string; seq: number }[];
  eventsOf: (runId: string) => SeqEvent[];
  out: (line: string) => void;
  /** Starts a run in the e2e session and leaves it queued. Returns the run id. */
  send: (text: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Resolves with the finished run, or the run as it was when the wait ran out. */
  wait: (
    runId: string
  ) => Promise<Pick<RunSummary, "error" | "resultText" | "status">>;
}

const messagesOf = (events: SeqEvent[]): string[] =>
  events
    .filter((event) => event.type === "message.assistant")
    .map((event) => String(event.payload.text ?? ""));

const expectStatus = async (
  deps: CloudDeps,
  runId: string,
  label: string,
  status: RunSummary["status"]
) => {
  const run = await deps.wait(runId);
  if (run.status !== status) {
    throw new CloudError(
      `${label}: run ${runId} ended as ${run.status}${run.error ? ` (${run.error})` : ""}, expected ${status}`
    );
  }
  return run;
};

const expectEqual = (label: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CloudError(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
};

const expectIncludes = (label: string, actual: string, expected: string) => {
  if (!actual.includes(expected)) {
    throw new CloudError(
      `${label}: expected the output to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
};

/** The result text of a finished run whose tool did not fail. */
const toolOutputOf = async (
  deps: CloudDeps,
  runId: string,
  label: string
): Promise<string> => {
  const run = await expectStatus(deps, runId, label, "done");
  const text = run.resultText ?? "";
  if (text.startsWith("tool failed")) {
    throw new CloudError(`${label}: the tool failed: ${text}`);
  }
  return text;
};

/** Runs the scenarios in order. Throws a CloudError naming the first that fails. */
export const runCloud = async (deps: CloudDeps): Promise<void> => {
  const runIds: string[] = [];
  const start = async (text: string) => {
    const runId = await deps.send(text);
    runIds.push(runId);
    return runId;
  };

  const first = await start("hello cloud");
  await deps.drive("offer", first);
  const firstRun = await expectStatus(deps, first, "first run", "done");
  expectEqual("first run result", firstRun.resultText, "echo: hello cloud");
  deps.out("ok 1: a run finishes through the normal lifecycle");

  const second = await start("second message");
  await deps.drive("offer", second);
  const secondRun = await expectStatus(deps, second, "second run", "done");
  expectEqual(
    "second run result",
    secondRun.resultText,
    "echo: second message"
  );
  expectEqual("second run events", messagesOf(deps.eventsOf(second)), [
    "echo: second message",
  ]);
  expectEqual("first run events", messagesOf(deps.eventsOf(first)), [
    "echo: hello cloud",
  ]);
  deps.out("ok 2: two runs in one session keep to their own events");

  const slow = await start("slow");
  await deps.drive("offer", slow);
  await deps.sleep(BUSY_MS);
  await deps.drive("redispatch", slow);
  await deps.sleep(BUSY_MS);
  deps.out("ok 3: the same run dispatched twice while it works");

  await deps.drive("cancel", slow);
  await expectStatus(deps, slow, "cancelled run", "cancelled");
  deps.out("ok 4: cancel stops the run");

  const after = await start("after the abort");
  await deps.drive("offer", after);
  const afterRun = await expectStatus(deps, after, "run after abort", "done");
  expectEqual("run after abort", afterRun.resultText, "echo: after the abort");
  deps.out("ok 5: the session takes a new run after an abort");

  const failing = await start("fail overloaded_error: try later");
  await deps.drive("offer", failing);
  const failedRun = await expectStatus(deps, failing, "failing run", "failed");
  if (!failedRun.error?.includes("overloaded_error: try later")) {
    throw new CloudError(
      `failing run: expected the model's error text, got ${failedRun.error}`
    );
  }
  deps.out("ok 6: a model failure ends the run with the model's text");

  const tool = await start("bash echo from-the-tool");
  await deps.drive("offer", tool);
  const toolRun = await expectStatus(deps, tool, "tool run", "done");
  if (!toolRun.resultText?.includes("from-the-tool")) {
    throw new CloudError(
      `tool run: expected the tool's output, got ${toolRun.resultText}`
    );
  }
  deps.out("ok 7: a tool call reaches the platform's /mcp");

  const write = await start(
    `call write ${JSON.stringify({ content: NOTES_BEFORE, path: NOTES_PATH })}`
  );
  await deps.drive("offer", write);
  expectIncludes(
    "library write",
    await toolOutputOf(deps, write, "library write"),
    "Successfully wrote"
  );

  const edit = await start(
    `call edit ${JSON.stringify({ edits: [NOTES_EDIT], path: NOTES_PATH })}`
  );
  await deps.drive("offer", edit);
  await toolOutputOf(deps, edit, "library edit");

  const read = await start(`call read ${JSON.stringify({ path: NOTES_PATH })}`);
  await deps.drive("offer", read);
  expectIncludes(
    "library read",
    await toolOutputOf(deps, read, "library read"),
    NOTES_AFTER
  );

  const cat = await start(`bash cat ${NOTES_PATH}`);
  await deps.drive("offer", cat);
  expectIncludes(
    "library cat",
    await toolOutputOf(deps, cat, "library cat"),
    NOTES_AFTER
  );
  deps.out(
    "ok 8: Pi's write, edit and read work on the library, and the platform's bash sees the edit"
  );

  const duplicates = deps.duplicateSeqs(runIds);
  if (duplicates.length > 0) {
    throw new CloudError(`duplicate seq rows: ${JSON.stringify(duplicates)}`);
  }
  deps.out("ok 9: no duplicate seq rows");
  deps.out("cloud runtime check passed");
};

/** `(run_id, seq)` pairs that appear more than once in `events`. */
export const findDuplicateSeqs = (
  client: Sqlite,
  runIds: string[]
): { runId: string; seq: number }[] => {
  if (runIds.length === 0) {
    return [];
  }
  const marks = runIds.map(() => "?").join(", ");
  return client
    .query<{ runId: string; seq: number }, string[]>(
      `SELECT run_id AS runId, seq FROM events
       WHERE seq IS NOT NULL AND run_id IN (${marks})
       GROUP BY run_id, seq HAVING count(*) > 1`
    )
    .all(...runIds);
};

/** The events of one run that carry a seq, in seq order. */
export const seqEventsOf = (client: Sqlite, runId: string): SeqEvent[] =>
  client
    .query<{ payload: string | null; seq: number; type: string }, [string]>(
      "SELECT payload, seq, type FROM events WHERE run_id = ? AND seq IS NOT NULL ORDER BY seq, id"
    )
    .all(runId)
    .map((row) => ({
      payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
      seq: row.seq,
      type: row.type,
    }));

/** Takes a run in and leaves it queued: the dev server dispatches it. */
const holdingCloudAdapter: RuntimeAdapter = {
  cancel: () => Promise.resolve(),
  dispatch: () => Promise.resolve(),
  kind: "cloud",
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { server: { type: "string" } },
    strict: true,
  });
  const server = (
    values.server ??
    process.env.HM_SERVER ??
    DEFAULT_SERVER
  ).replace(TRAILING_SLASHES, "");
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  const client = openSqlite(local.file);
  const { db } = local;
  try {
    const principal = await devUserPrincipal(db, orgId);
    const runs = createRunsService({
      adapters: [holdingCloudAdapter],
      atomic: sqliteAtomic(db as Database),
      blobs: memoryBlobs(),
      clock: systemClock,
      db,
      devFakeRuntime: false,
      gateways: [],
    });
    const agent = await createAgentsService({
      db,
      events: localEvents(db),
    }).create(principal, {
      instructions: "Answer from the script.",
      model: AGENT_MODEL,
      name: "Cloud faux",
      runtime: "cloud",
      slug: `cloud-faux-${Date.now()}`,
    });
    process.stdout.write(`agent ${agent.id}\n`);
    const sessionKey = `e2e-cloud-${Date.now()}`;
    await runCloud({
      drive: async (action, runId) => {
        const response = await fetch(`${server}/api/dev/cloud/${action}`, {
          body: JSON.stringify({ runId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          throw new CloudError(
            `${server}/api/dev/cloud/${action} answered ${response.status}. Is the dev server running?`
          );
        }
      },
      duplicateSeqs: (runIds) => findDuplicateSeqs(client, runIds),
      eventsOf: (runId) => seqEventsOf(client, runId),
      out: (line) => process.stdout.write(`${line}\n`),
      send: async (text) => {
        const { runId } = await runs.startRun(principal, {
          agentId: agent.id,
          input: { text },
          session: { externalKey: sessionKey, origin: "ui" },
        });
        return runId;
      },
      sleep: (ms) => systemClock.sleep(ms),
      wait: async (runId) => {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
          // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
          const summary = await runs.waitForRun(principal, runId, POLL_MS * 10);
          const finished =
            summary.status === "done" ||
            summary.status === "failed" ||
            summary.status === "cancelled" ||
            summary.status === "interrupted";
          if (finished || Date.now() > deadline) {
            return summary;
          }
        }
      },
    });
  } finally {
    client.close();
    local.close();
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
