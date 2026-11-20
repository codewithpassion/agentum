#!/usr/bin/env bun
// Makes a team lead propose a change to a member, through the running dev
// server's /mcp route, because the fake runtime cannot call tools. It takes the
// lead's newest team room run, marks it running for the call, mints a run token
// with RUN_TOKEN_KEY from apps/web/.env.local, calls `team_propose_change` and
// puts the run back as it was. `--tool <name> --args <json>` calls any other
// tool of the lead's room run instead, for example `team_open_topic`. The owner then approves the card in the app.
// Run from the repo root, after the lead has answered in its team room:
// `bun scripts/dev/team-propose.ts --server http://localhost:3417 --lead <slug>
//   --agent <memberAgentId> --field instructions --value "..." --reason "..."`.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import {
  D1_DIR,
  ENV_FILE,
  findLocalD1,
  LocalError,
  openSqlite,
  runCli,
} from "./local.ts";

const LEASE_MS = 60_000;
const KEY_LINE = /^RUN_TOKEN_KEY=(.+)$/m;

interface RunRow {
  agent_id: string;
  id: string;
  status: string;
  workspace_id: string;
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      args: { type: "string" },
      field: { type: "string" },
      lead: { type: "string" },
      reason: { type: "string" },
      server: { type: "string" },
      tool: { type: "string" },
      value: { type: "string" },
    },
  });
  const { agent, args, field, lead, reason, server, tool, value } = values;
  const callArgs: unknown = args
    ? JSON.parse(args)
    : { agentId: agent, field, reason, value };
  if (!(lead && server && (args || (agent && field && reason && value)))) {
    throw new LocalError(
      "Usage: --server <url> --lead <slug> (--agent <id> --field <field> --value <text> --reason <text> | --tool <name> --args <json>)"
    );
  }
  const keySpec = KEY_LINE.exec(readFileSync(ENV_FILE, "utf8"))?.[1]?.trim();
  if (!keySpec) {
    throw new LocalError(`No RUN_TOKEN_KEY in ${ENV_FILE}.`);
  }
  const file = findLocalD1(D1_DIR);
  if (!file) {
    throw new LocalError("No local database. Start the dev server first.");
  }
  const sqlite = openSqlite(file);
  try {
    const run = sqlite
      .query<RunRow, [string]>(
        `SELECT r.id, r.agent_id, r.status, r.workspace_id
         FROM runs r
         JOIN agents a ON a.id = r.agent_id
         JOIN sessions s ON s.id = r.session_id
         WHERE a.slug = ? AND s.origin = 'inbox'
         ORDER BY r.id DESC LIMIT 1`
      )
      .get(lead);
    if (!run) {
      throw new LocalError(`No team room run for agent ${lead}.`);
    }
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    sqlite
      .query("UPDATE runs SET status = 'running', lease_until = ? WHERE id = ?")
      .run(lease, run.id);
    try {
      const token = await signRunToken(await importRunTokenKey(keySpec), {
        agentId: run.agent_id,
        issuedAt: Date.now(),
        runId: run.id,
        workspaceId: run.workspace_id,
      });
      const response = await fetch(`${server}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: callArgs,
            name: tool ?? "team_propose_change",
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      process.stdout.write(`${response.status} ${await response.text()}\n`);
    } finally {
      sqlite
        .query("UPDATE runs SET status = ?, lease_until = NULL WHERE id = ?")
        .run(run.status, run.id);
    }
  } finally {
    sqlite.close();
  }
};

runCli(main);
