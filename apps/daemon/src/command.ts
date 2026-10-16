// Running local commands, injected everywhere so the code that calls them is
// testable.

import { spawn } from "bun";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  /** The raw standard output, for commands whose output is a file's bytes. Real runs always set it. */
  readonly stdoutBytes?: Uint8Array;
}

/** Runs `command`. `stdin`, when given, is fed to it as its standard input. */
export type CommandRunner = (
  command: string[],
  stdin?: Uint8Array
) => Promise<CommandResult>;

const COMMAND_NOT_FOUND = 127;

export const spawnCommand: CommandRunner = async (command, stdin) => {
  try {
    // Without input, stdin is inherited so `sudo` can ask for a password on the terminal.
    const proc = spawn(command, {
      stderr: "pipe",
      stdin: stdin ?? "inherit",
      stdout: "pipe",
    });
    const [stdoutBytes, stderr] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      exitCode,
      stderr,
      stdout: new TextDecoder().decode(stdoutBytes),
      stdoutBytes,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { exitCode: COMMAND_NOT_FOUND, stderr: detail, stdout: "" };
  }
};
