#!/usr/bin/env bun
// Seeds one decision queue (a `decisions` request) on the newest run of an
// agent in the local database that `bun run dev` in apps/web uses, so the card
// has something to show. The queue has three questions, the last with a
// free-text choice, and the first already answered when `--partial` is given.
// It makes no Clerk user. Prints the request id on stdout, progress on stderr.
// Run from the repo root, after a conversation with the agent has made a run:
// `bun scripts/dev/seed-decisions.ts <agentId> [--partial]`.
import { parseArgs } from "node:util";
import {
  D1_DIR,
  findLocalD1,
  LocalError,
  openSqlite,
  runCli,
} from "./local.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const BASE = 32;
const DAY_MS = 86_400_000;

/** A ULID at the given time. ulidx is not a dependency of the repo root. */
const ulid = (time: number): string => {
  let stamp = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    stamp = `${CROCKFORD[rest % BASE]}${stamp}`;
    rest = Math.floor(rest / BASE);
  }
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
  return stamp + [...random].map((byte) => CROCKFORD[byte % BASE]).join("");
};

const DISPLAY = {
  questions: [
    {
      id: "q1",
      options: ["Ship it", "Hold a week"],
      text: "When do we launch?",
    },
    {
      id: "q2",
      options: ["Email", "Slack", "Both"],
      text: "Where should the announcement go?",
    },
    {
      freeText: true,
      id: "q3",
      options: ["Dom", "Sam"],
      text: "Who signs it off?",
    },
  ],
};

interface RunRow {
  agent_id: string;
  id: string;
  session_id: string;
  workspace_id: string;
}

// biome-ignore lint/suspicious/useAwait: runCli takes an async main, and the script writes with bun:sqlite
export const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { partial: { default: false, type: "boolean" } },
  });
  const [agentId] = positionals;
  if (!agentId) {
    throw new LocalError(
      "Usage: bun scripts/dev/seed-decisions.ts <agentId> [--partial]"
    );
  }
  const file = findLocalD1(D1_DIR);
  if (!file) {
    throw new LocalError(`No local D1 database in ${D1_DIR}.`);
  }
  const client = openSqlite(file);
  try {
    const run = client
      .query<RunRow, [string]>(
        "SELECT id, session_id, agent_id, workspace_id FROM runs WHERE agent_id = ? AND status != 'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(agentId);
    if (!run) {
      throw new LocalError(
        `Agent ${agentId} has no run. Start a conversation with it in the app first.`
      );
    }
    const now = Date.now();
    const requestId = ulid(now);
    client
      .query(
        `INSERT INTO run_requests (id, workspace_id, agent_id, run_id, session_id, kind, status, tool_name, tool_use_id, display, answer, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'decisions', 'pending', 'ask_decisions', ?, ?, ?, ?, ?)`
      )
      .run(
        requestId,
        run.workspace_id,
        run.agent_id,
        run.id,
        run.session_id,
        `decisions:${ulid(now)}`,
        JSON.stringify(DISPLAY),
        values.partial
          ? JSON.stringify({ decisions: { q1: "Ship it" } })
          : null,
        new Date(now + DAY_MS).toISOString(),
        new Date(now).toISOString()
      );
    process.stderr.write(
      `Raised decisions ${requestId} on run ${run.id} (${file}).\n`
    );
    process.stdout.write(`${requestId}\n`);
  } finally {
    client.close();
  }
};

if (import.meta.main) {
  runCli(main);
}
