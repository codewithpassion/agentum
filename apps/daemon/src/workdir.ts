// The per-agent work directory that Claude Code runs in. Before each run the
// daemon makes sure it exists and empties its `.claude/` and `.mcp.json`, and,
// in single-user mode, `inbox/`, where the run's input files are downloaded. In
// multi-user mode hm-agent owns the directory, so the daemon reaches it through
// sudo. In single-user mode it is a plain directory under the daemon's home.

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_HOME, AGENT_MKDIR, AGENT_RM, AGENT_USER } from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";

/** Where a run's input files are downloaded, relative to the work directory. */
export const INBOX_DIR = "inbox";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const assertSafeId = (name: string, id: string): void => {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `${name} may only hold letters, digits, "_" and "-": ${JSON.stringify(id)}`
    );
  }
};

/** `<home>/harbourmaster/<workspaceId>/<agentId>/work` */
export const workDirPath = (
  home: string,
  workspaceId: string,
  agentId: string
): string => {
  assertSafeId("workspaceId", workspaceId);
  assertSafeId("agentId", agentId);
  return join(home, "harbourmaster", workspaceId, agentId, "work");
};

export interface PrepareWorkDirOptions {
  agentId: string;
  /** The daemon user's home, used when singleUser is true. Defaults to os.homedir(). */
  daemonHome?: string;
  run: CommandRunner;
  singleUser: boolean;
  workspaceId: string;
}

const runStep = async (
  run: CommandRunner,
  step: string,
  command: string[]
): Promise<void> => {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new Error(`${step} failed: ${result.stderr.trim()}`);
  }
};

/** Ensures the work dir exists and empties `.claude/` and `.mcp.json` inside it (and `inbox/` in single-user mode). Returns the dir. Throws an Error naming the failed step. */
export const prepareWorkDir = async (
  options: PrepareWorkDirOptions
): Promise<string> => {
  const { agentId, run, singleUser, workspaceId } = options;
  const daemonHome = options.daemonHome ?? homedir();
  if (singleUser) {
    const dir = workDirPath(daemonHome, workspaceId, agentId);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, ".claude"), { force: true, recursive: true });
    rmSync(join(dir, ".mcp.json"), { force: true, recursive: true });
    rmSync(join(dir, INBOX_DIR), { force: true, recursive: true });
    return dir;
  }

  const dir = workDirPath(AGENT_HOME, workspaceId, agentId);
  const asAgent = ["sudo", "-n", "-u", AGENT_USER];
  await runStep(run, "mkdir", [...asAgent, AGENT_MKDIR, "-p", dir]);
  await runStep(run, "rm", [
    ...asAgent,
    AGENT_RM,
    "-rf",
    `${dir}/.claude`,
    `${dir}/.mcp.json`,
  ]);
  return dir;
};
