// The per-agent work directory that Claude Code runs in. Before each run the
// daemon makes sure it exists and empties its `.claude/`, `.mcp.json`, `inbox/`
// (where the run's input files are downloaded) and `tmp/` (the agent's scratch
// space), then recreates `tmp/` empty, in both modes. Everything else stays,
// including `library/` (the copy of the workspace library) and its manifest
// `library.manifest.json`, which the library sync reads at the next run. In
// multi-user mode hm-agent owns the directory, so the daemon reaches it
// through sudo. In single-user mode it is a plain directory under the daemon's
// home.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_HOME,
  AGENT_MKDIR,
  AGENT_RM,
  AGENT_STAT,
  AS_AGENT,
} from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";

/** Where a run's input files are downloaded, relative to the work directory. */
export const INBOX_DIR = "inbox";

/** The agent's scratch directory, relative to the work directory. Emptied before each run. */
export const SCRATCH_DIR = "tmp";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The folder under the home that holds every work directory. */
export const WORK_ROOT = "agentum";
/**
 * The folder an install from before the rename to Agentum used. When it
 * exists the daemon keeps using it, so the agents keep their files.
 */
export const LEGACY_WORK_ROOT = "harbourmaster";

const assertSafeId = (name: string, id: string): void => {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `${name} may only hold letters, digits, "_" and "-": ${JSON.stringify(id)}`
    );
  }
};

/** `<home>/<root>/<workspaceId>/<agentId>/work`, `<root>` being `agentum` by default. */
export const workDirPath = (
  home: string,
  workspaceId: string,
  agentId: string,
  root: string = WORK_ROOT
): string => {
  assertSafeId("workspaceId", workspaceId);
  assertSafeId("agentId", agentId);
  return join(home, root, workspaceId, agentId, "work");
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

/** Ensures the work dir exists and empties `.claude/`, `.mcp.json`, `inbox/` and `tmp/` inside it, then recreates `tmp/` empty, in both modes. Returns the dir. Throws an Error naming the failed step. */
export const prepareWorkDir = async (
  options: PrepareWorkDirOptions
): Promise<string> => {
  const { agentId, run, singleUser, workspaceId } = options;
  const daemonHome = options.daemonHome ?? homedir();
  if (singleUser) {
    const root = existsSync(join(daemonHome, LEGACY_WORK_ROOT))
      ? LEGACY_WORK_ROOT
      : WORK_ROOT;
    const dir = workDirPath(daemonHome, workspaceId, agentId, root);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, ".claude"), { force: true, recursive: true });
    rmSync(join(dir, ".mcp.json"), { force: true, recursive: true });
    rmSync(join(dir, INBOX_DIR), { force: true, recursive: true });
    rmSync(join(dir, SCRATCH_DIR), { force: true, recursive: true });
    mkdirSync(join(dir, SCRATCH_DIR), { recursive: true });
    return dir;
  }

  // Checked before anything runs, so a bad id throws before the stat.
  workDirPath(AGENT_HOME, workspaceId, agentId);
  const legacy = await run([
    ...AS_AGENT,
    AGENT_STAT,
    join(AGENT_HOME, LEGACY_WORK_ROOT),
  ]);
  const root = legacy.exitCode === 0 ? LEGACY_WORK_ROOT : WORK_ROOT;
  const dir = workDirPath(AGENT_HOME, workspaceId, agentId, root);
  await runStep(run, "mkdir", [...AS_AGENT, AGENT_MKDIR, "-p", dir]);
  await runStep(run, "rm", [
    ...AS_AGENT,
    AGENT_RM,
    "-rf",
    `${dir}/.claude`,
    `${dir}/.mcp.json`,
    `${dir}/${INBOX_DIR}`,
    `${dir}/${SCRATCH_DIR}`,
  ]);
  await runStep(run, "mkdir tmp", [
    ...AS_AGENT,
    AGENT_MKDIR,
    "-p",
    `${dir}/${SCRATCH_DIR}`,
  ]);
  return dir;
};
