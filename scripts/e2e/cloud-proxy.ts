#!/usr/bin/env bun
// The connector proxy in a cloud run, live. The proxy (`/api/proxy/<connectorId>`)
// is the MCP server a cloud agent reaches for each connector it has, and its SSRF
// guard refuses localhost. So the stub MCP server runs on this machine and a
// Cloudflare quick tunnel makes it public:
//   bun scripts/dev/stub-mcp.ts --no-auth --port 8787
//   cloudflared tunnel --config /dev/null --url http://localhost:8787
// Pass the tunnel's https URL with its /mcp path as --connector-url. The dev server
// needs the Worker's own origin in `PUBLIC_BASE_URL`, as scripts/e2e/cloud.ts
// describes. Run from the repo root:
//   bun scripts/e2e/cloud-proxy.ts --connector-url https://<tunnel>.trycloudflare.com/mcp [--server <url>]
// The agents' model is `faux`, so no API key is used. The script seeds connectors
// and agents straight into the local D1 database, then asks the dev server to
// dispatch the runs (POST /api/dev/cloud/offer).
import type { Database as Sqlite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { sqliteAtomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import {
  seedAssignment,
  seedConnector,
} from "@repo/services/connectors/test-seed";
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
const AGENT_MODEL = "faux";
const STUB_NAME = "stub";
const DEAD_NAME = "dead";
/** Nothing resolves under `.invalid`, so every call to this connector fails. */
export const DEAD_CONNECTOR_URL = "https://dead.invalid/mcp";

export class ProxyError extends Error {}

/** One event of a run, as the events table stores it. */
export interface RunEvent {
  payload: Record<string, unknown>;
  type: string;
}

export interface ProxyDeps {
  /** Gives an agent one of the seeded connectors. */
  assign: (agentId: string, connectorId: string) => Promise<void>;
  /** Seeds a connector with no auth and returns its id. */
  connect: (name: string, url: string) => Promise<string>;
  /** The stub's MCP endpoint, public https. The connector named `stub` points at it. */
  connectorUrl: string;
  /** Creates an agent on the faux model and returns its id. */
  createAgent: (name: string) => Promise<string>;
  /** `offer` for a run, on the dev server. */
  drive: (action: string, runId: string) => Promise<void>;
  /** The events of one run. */
  eventsOf: (runId: string) => RunEvent[];
  out: (line: string) => void;
  /** Starts a run for an agent, in that agent's session, and leaves it queued. Returns the run id. */
  send: (agentId: string, text: string) => Promise<string>;
  /** Resolves with the finished run, or the run as it was when the wait ran out. */
  wait: (
    runId: string
  ) => Promise<Pick<RunSummary, "error" | "resultText" | "status">>;
}

const expectStatus = async (
  deps: ProxyDeps,
  runId: string,
  label: string,
  status: RunSummary["status"]
) => {
  const run = await deps.wait(runId);
  if (run.status !== status) {
    throw new ProxyError(
      `${label}: run ${runId} ended as ${run.status}${run.error ? ` (${run.error})` : ""}, expected ${status}`
    );
  }
  return run;
};

const expectText = (label: string, text: string | null, expected: string) => {
  if (!text?.includes(expected)) {
    throw new ProxyError(
      `${label}: expected the result to contain ${JSON.stringify(expected)}, got ${JSON.stringify(text)}`
    );
  }
};

/** Runs the scenarios in order. Throws a ProxyError naming the first that fails. */
export const runCloudProxy = async (deps: ProxyDeps): Promise<void> => {
  const start = async (agentId: string, text: string) => {
    const runId = await deps.send(agentId, text);
    await deps.drive("offer", runId);
    return runId;
  };

  const stubId = await deps.connect(STUB_NAME, deps.connectorUrl);
  const solo = await deps.createAgent("Proxy stub");
  await deps.assign(solo, stubId);

  const proxied = await start(
    solo,
    'call stub_echo {"text":"through-the-proxy"}'
  );
  const proxiedRun = await expectStatus(deps, proxied, "proxy run", "done");
  expectText("proxy run", proxiedRun.resultText, "through-the-proxy");
  const calls = deps
    .eventsOf(proxied)
    .filter((event) => event.type === "connector.call");
  const okCall = calls.some(
    (event) =>
      event.payload.connectorId === stubId && event.payload.outcome === "ok"
  );
  if (!okCall) {
    throw new ProxyError(
      `proxy run: expected an ok connector.call for ${stubId}, got ${JSON.stringify(calls)}`
    );
  }
  deps.out("ok 1: a tool call through the connector proxy reaches the stub");

  const deadId = await deps.connect(DEAD_NAME, DEAD_CONNECTOR_URL);
  const mixed = await deps.createAgent("Proxy stub and dead");
  await deps.assign(mixed, stubId);
  await deps.assign(mixed, deadId);

  const bash = await start(mixed, "bash echo still-works");
  const bashRun = await expectStatus(deps, bash, "bash run", "done");
  expectText("bash run", bashRun.resultText, "still-works");
  deps.out("ok 2: an unreachable connector does not fail the run start");

  const after = await start(mixed, 'call stub_echo {"text":"after-dead"}');
  const afterRun = await expectStatus(deps, after, "run after dead", "done");
  expectText("run after dead", afterRun.resultText, "after-dead");
  deps.out("ok 3: the proxied tool still answers beside a dead connector");
  deps.out("cloud proxy check passed");
};

/** The connector.call events of one run, in write order. */
export const connectorCallsOf = (client: Sqlite, runId: string): RunEvent[] =>
  client
    .query<{ payload: string | null; type: string }, [string]>(
      "SELECT payload, type FROM events WHERE run_id = ? AND type = 'connector.call' ORDER BY id"
    )
    .all(runId)
    .map((row) => ({
      payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
      type: row.type,
    }));

/** Takes a run in and leaves it queued: the dev server dispatches it. */
const holdingCloudAdapter: RuntimeAdapter = {
  cancel: () => Promise.resolve(),
  dispatch: () => Promise.resolve(),
  kind: "cloud",
};

/** The stub's MCP endpoint from `--connector-url`: an https URL. */
export const parseConnectorUrl = (value: string | undefined): string => {
  if (value === undefined) {
    throw new ProxyError(
      "--connector-url is required: the public https URL of the stub's /mcp endpoint, through a tunnel"
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new ProxyError(`--connector-url is not a URL: ${value}`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:") {
    throw new ProxyError(
      `--connector-url must be https (the proxy refuses plain http): ${value}`
    );
  }
  return url.toString();
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      "connector-url": { type: "string" },
      server: { type: "string" },
    },
    strict: true,
  });
  const connectorUrl = parseConnectorUrl(values["connector-url"]);
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
    const agents = createAgentsService({ db, events: localEvents(db) });
    await runCloudProxy({
      assign: (agentId, connectorId) =>
        seedAssignment(db, {
          agentId,
          connectorId,
          now: new Date().toISOString(),
          workspaceId: principal.workspaceId,
        }),
      connect: async (name, url) => {
        const id = randomUUID();
        await seedConnector(db, {
          authKind: "none",
          id,
          name,
          now: new Date().toISOString(),
          url,
          workspaceId: principal.workspaceId,
        });
        return id;
      },
      connectorUrl,
      createAgent: async (name) => {
        const agent = await agents.create(principal, {
          instructions: "Answer from the script.",
          model: AGENT_MODEL,
          name,
          runtime: "cloud",
          slug: `cloud-proxy-${Date.now()}-${randomUUID().slice(0, 8)}`,
        });
        process.stdout.write(`agent ${agent.id}\n`);
        return agent.id;
      },
      drive: async (action, runId) => {
        const response = await fetch(`${server}/api/dev/cloud/${action}`, {
          body: JSON.stringify({ runId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          throw new ProxyError(
            `${server}/api/dev/cloud/${action} answered ${response.status}. Is the dev server running?`
          );
        }
      },
      eventsOf: (runId) => connectorCallsOf(client, runId),
      out: (line) => process.stdout.write(`${line}\n`),
      send: async (agentId, text) => {
        const { runId } = await runs.startRun(principal, {
          agentId,
          input: { text },
          session: { externalKey: `e2e-cloud-proxy-${agentId}`, origin: "ui" },
        });
        return runId;
      },
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
