// How the Agent SDK starts Claude Code. The SDK hands `spawnClaudeCodeProcess`
// a command, its arguments, a working directory and an environment. In
// multi-user mode this module puts `sudo -u hm-agent` in front. The daemon's
// own user cannot enter hm-agent's home, so the work directory goes to sudo as
// `-D` (the sudoers rule carries `CWD=*`) and the child itself starts in `/`.
// sudo's `env_reset` decides which variables reach Claude Code, so nothing is
// ever put on the command line.

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { AGENT_USER } from "./agent-user.ts";

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcess;

export interface AgentSpawnerOptions {
  /** Receives Claude Code's stderr as it arrives. */
  onStderr?: (text: string) => void;
  /** Variables sudo must keep, by name. Their values travel in the spawn's env. */
  preserveEnv?: readonly string[];
  singleUser: boolean;
  spawn?: SpawnFn;
}

const SUDO = "sudo";
const ROOT = "/";

/** The command and arguments that start Claude Code for these SDK options. */
export const agentCommand = (
  options: Pick<SpawnOptions, "args" | "command" | "cwd">,
  singleUser: boolean,
  preserveEnv: readonly string[] = []
): { args: string[]; command: string } => {
  if (singleUser) {
    return { args: options.args, command: options.command };
  }
  const chdir = options.cwd === undefined ? [] : ["-D", options.cwd];
  const preserve =
    preserveEnv.length === 0 ? [] : [`--preserve-env=${preserveEnv.join(",")}`];
  return {
    args: [
      "-n",
      "-u",
      AGENT_USER,
      "-H",
      ...preserve,
      ...chdir,
      options.command,
      ...options.args,
    ],
    command: SUDO,
  };
};

export const createAgentSpawner =
  (spawnOptions: AgentSpawnerOptions) =>
  (options: SpawnOptions): SpawnedProcess => {
    const { onStderr, preserveEnv, singleUser } = spawnOptions;
    const spawn: SpawnFn = spawnOptions.spawn ?? nodeSpawn;
    const { args, command } = agentCommand(options, singleUser, preserveEnv);
    const child = spawn(command, args, {
      cwd: singleUser ? (options.cwd ?? ROOT) : ROOT,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (onStderr) {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", onStderr);
    }
    if (!(child.stdin && child.stdout)) {
      throw new Error("Claude Code started without stdin or stdout");
    }
    // The SDK documents ChildProcess as a SpawnedProcess; the typings in
    // bun-types do not carry the `exit` and `error` overloads it needs.
    return child as unknown as SpawnedProcess;
  };
