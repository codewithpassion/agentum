#!/usr/bin/env bun
// Starts a run for the `machine-echo` agent on a machine, in the local D1
// database, as the dev user. The run stays `queued` until the daemon says
// hello and claims it. Prints the run id on stdout. Progress and errors go to
// stderr. Run from the repo root:
// `bun scripts/dev/start-machine-run.ts --machine <machineId> [--text "hello"]`.
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { sqliteAtomic } from "@repo/db/atomic";
import { type AgentsService, createAgentsService } from "@repo/services/agents";
import { createMachineRuntime } from "@repo/services/machines/runtime";
import { noopRelay } from "@repo/services/machines/types";
import { createRunsService, type RunsService } from "@repo/services/runs";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import {
  devUserPrincipal,
  LocalError,
  localEvents,
  memoryBlobs,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";

const AGENT_SLUG = "machine-echo";
const AGENT_NAME = "Machine echo";
const AGENT_MODEL = "claude-sonnet-4-5";
const AGENT_INSTRUCTIONS = "Echoes whatever it is told.";
const DEFAULT_TEXT = "Hello from the dev script";

/** The runs service the dev scripts use. The machine adapter only offers runs, so nothing runs here. */
export const localRuns = (db: Database): RunsService =>
  createRunsService({
    adapters: [createMachineRuntime({ relay: noopRelay })],
    atomic: sqliteAtomic(db),
    blobs: memoryBlobs(),
    clock: systemClock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });

/**
 * The id of the `machine-echo` agent on `machineId`. Creates the agent when it
 * is missing. Throws when the agent is archived or on another machine.
 */
const ensureAgent = async (
  agents: AgentsService,
  principal: Principal,
  machineId: string
): Promise<string> => {
  const existing = (
    await agents.list(principal, { includeArchived: true })
  ).find((agent) => agent.slug === AGENT_SLUG);
  if (!existing) {
    const created = await agents.create(principal, {
      instructions: AGENT_INSTRUCTIONS,
      machineId,
      model: AGENT_MODEL,
      name: AGENT_NAME,
      runtime: "machine",
      slug: AGENT_SLUG,
    });
    return created.id;
  }
  if (existing.status === "archived") {
    throw new LocalError(
      `Agent ${AGENT_SLUG} (${existing.id}) is archived, so it cannot take runs.`
    );
  }
  if (existing.runtime !== "machine" || existing.machineId !== machineId) {
    throw new LocalError(
      `Agent ${AGENT_SLUG} (${existing.id}) is not assigned to machine ${machineId}.`
    );
  }
  return existing.id;
};

/** Starts a run of the `machine-echo` agent on `machineId`. Returns both ids. */
export const startMachineRun = async ({
  db,
  machineId,
  orgId,
  text,
}: {
  db: Database;
  machineId: string;
  orgId: string;
  text: string;
}): Promise<{ agentId: string; runId: string }> => {
  const principal = await devUserPrincipal(db, orgId);
  const agents = createAgentsService({ db, events: localEvents(db) });
  const agentId = await ensureAgent(agents, principal, machineId);
  const { runId } = await localRuns(db).startRun(principal, {
    agentId,
    input: { text },
    session: { origin: "ui" },
  });
  return { agentId, runId };
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      machine: { type: "string" },
      text: { type: "string" },
    },
    strict: true,
  });
  if (!values.machine) {
    throw new LocalError("Pass --machine <machineId>.");
  }
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  process.stderr.write(`Starting a run in ${local.file}.\n`);
  try {
    const { runId } = await startMachineRun({
      db: local.db,
      machineId: values.machine,
      orgId,
      text: values.text ?? DEFAULT_TEXT,
    });
    process.stdout.write(`${runId}\n`);
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
