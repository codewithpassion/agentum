#!/usr/bin/env bun
// The walking-skeleton check, live. It needs `bun run dev` (or a vite dev on
// another port, with --server), a running daemon enrolled against it, and a
// Claude Code login on the machine. It creates an agent whose instructions
// name it Pelican, and sends three messages to one session:
//   1. "What is your name? Reply with the name only"  -> the reply has "Pelican"
//      (the instructions reached the model).
//   2. "Reply with exactly the word heron"            -> the reply has "heron".
//   3. "Which word did I ask for in my previous message?" -> the reply has
//      "heron" (the session resumed).
// Runs are written straight into the local D1 database, as scripts/dev does,
// and the dev server's relay is asked to offer each one. Run from the repo root:
// `bun scripts/e2e/skeleton.ts [--machine <id>] [--server <url>] [--model <m>]`.
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { createAgentsService } from "@repo/services/agents";
import type { RunSummary } from "@repo/services/runs/types";
import {
  devUserPrincipal,
  LocalError,
  localEvents,
  localMachines,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "../dev/local.ts";
import { localRuns } from "../dev/start-machine-run.ts";

const DEFAULT_SERVER = "http://localhost:3000";
const TRAILING_SLASHES = /\/+$/;
const DEFAULT_MODEL = "haiku";
const RUN_TIMEOUT_MS = 180_000;
const POLL_MS = 1000;
const MS_PER_SECOND = 1000;

export const INSTRUCTIONS =
  "You are called Pelican. Answer briefly, in as few words as the question allows.";

export interface Step {
  /** Lower case words the reply must contain. */
  expect: string;
  label: string;
  prompt: string;
}

export const STEPS: readonly Step[] = [
  {
    expect: "pelican",
    label: "the instructions reached the model",
    prompt: "What is your name? Reply with the name only",
  },
  {
    expect: "heron",
    label: "a second message in the session",
    prompt: "Reply with exactly the word heron",
  },
  {
    expect: "heron",
    label: "the session resumed",
    prompt: "Which word did I ask for in my previous message?",
  },
];

export class SkeletonError extends Error {}

export interface SkeletonDeps {
  /** Creates the agent on a machine and returns its id and the machine's. */
  createAgent: (instructions: string) => Promise<{
    agentId: string;
    machineId: string;
  }>;
  out: (line: string) => void;
  /** Starts a run in the e2e session and has the relay offer it. Returns the run id. */
  send: (agentId: string, machineId: string, text: string) => Promise<string>;
  /** Resolves with the finished run, or the run as it was when the wait ran out. */
  wait: (
    runId: string
  ) => Promise<Pick<RunSummary, "error" | "resultText" | "status">>;
}

/** Runs the three steps in order. Throws a SkeletonError naming the first that fails. */
export const runSkeleton = async (deps: SkeletonDeps): Promise<void> => {
  const { agentId, machineId } = await deps.createAgent(INSTRUCTIONS);
  deps.out(`agent ${agentId} on machine ${machineId}`);
  const play = async (index: number): Promise<void> => {
    const step = STEPS[index];
    if (step === undefined) {
      return;
    }
    const runId = await deps.send(agentId, machineId, step.prompt);
    const run = await deps.wait(runId);
    if (run.status !== "done") {
      throw new SkeletonError(
        `step ${index + 1} (${step.label}): run ${runId} ended as ${run.status}${run.error ? `: ${run.error}` : ""}`
      );
    }
    const reply = run.resultText ?? "";
    if (!reply.toLowerCase().includes(step.expect)) {
      throw new SkeletonError(
        `step ${index + 1} (${step.label}): expected the reply to contain "${step.expect}", got: ${reply}`
      );
    }
    deps.out(`ok ${index + 1}: ${step.label}: ${reply.trim()}`);
    await play(index + 1);
  };
  await play(0);
  deps.out("walking skeleton passed");
};

const onlineMachine = async (
  db: Database,
  orgId: string,
  wanted: string | undefined
): Promise<string> => {
  const principal = await devUserPrincipal(db, orgId);
  const machines = await localMachines(db).list(principal);
  const machine = machines.find((candidate) =>
    wanted === undefined
      ? candidate.status === "online"
      : candidate.id === wanted
  );
  if (!machine) {
    throw new LocalError(
      wanted === undefined
        ? "No machine is online. Start the daemon (`agentum run`) against this server first."
        : `Machine ${wanted} was not found.`
    );
  }
  return machine.id;
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      machine: { type: "string" },
      model: { type: "string" },
      server: { type: "string" },
    },
    strict: true,
  });
  const server = (
    values.server ??
    process.env.HM_SERVER ??
    DEFAULT_SERVER
  ).replace(TRAILING_SLASHES, "");
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  const { db } = local;
  try {
    const principal = await devUserPrincipal(db, orgId);
    const runs = localRuns(db);
    const sessionKey = `e2e-${Date.now()}`;
    await runSkeleton({
      createAgent: async (instructions) => {
        const machineId = await onlineMachine(db, orgId, values.machine);
        const agent = await createAgentsService({
          db,
          events: localEvents(db),
        }).create(principal, {
          instructions,
          machineId,
          model: values.model ?? DEFAULT_MODEL,
          name: "Pelican",
          runtime: "machine",
          slug: `pelican-${Date.now()}`,
        });
        return { agentId: agent.id, machineId };
      },
      out: (line) => process.stdout.write(`${line}\n`),
      send: async (agentId, machineId, text) => {
        const { runId } = await runs.startRun(principal, {
          agentId,
          input: { text },
          session: { externalKey: sessionKey, origin: "ui" },
        });
        const offered = await fetch(`${server}/api/dev/offer`, {
          body: JSON.stringify({ agentId, machineId, runId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!offered.ok) {
          throw new SkeletonError(
            `${server}/api/dev/offer answered ${offered.status}. Is \`bun run dev\` running?`
          );
        }
        return runId;
      },
      wait: (runId) => {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        const poll = async (): Promise<RunSummary> => {
          const summary = await runs.waitForRun(principal, runId, POLL_MS * 10);
          const finished =
            summary.status === "done" ||
            summary.status === "failed" ||
            summary.status === "cancelled" ||
            summary.status === "interrupted";
          if (finished || Date.now() > deadline) {
            return summary;
          }
          return poll();
        };
        process.stderr.write(
          `waiting up to ${RUN_TIMEOUT_MS / MS_PER_SECOND}s for run ${runId}\n`
        );
        return poll();
      },
    });
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
