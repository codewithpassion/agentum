// Running local commands, injected everywhere so the code that calls them is
// testable.

import { spawn } from "bun";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (command: string[]) => Promise<CommandResult>;

const COMMAND_NOT_FOUND = 127;

export const spawnCommand: CommandRunner = async (command) => {
  try {
    // stdin is inherited so `sudo` can ask for a password on the terminal.
    const proc = spawn(command, {
      stderr: "pipe",
      stdin: "inherit",
      stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stderr, stdout };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { exitCode: COMMAND_NOT_FOUND, stderr: detail, stdout: "" };
  }
};
