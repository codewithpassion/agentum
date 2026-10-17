/** One file placed in the sandbox. `path` is relative to the skill folder, e.g. "scripts/hello.ts". */
export interface SandboxFile {
  bytes: Uint8Array;
  path: string;
}

export interface SandboxRunInput {
  /** The script's arguments, as `process.argv.slice(2)` shows them. */
  args: string[];
  /** The script to run: one of `files`, by path. */
  entry: string;
  /** Every file of the skill. */
  files: SandboxFile[];
  /** What the caller shows of each of stdout and stderr. A backend keeps at least this much of each, and may cap far above it to protect its own memory. */
  maxOutputBytes: number;
  /** Wall time for the run. A backend stops the script when it passes. */
  timeoutMs: number;
}

export interface SandboxRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Where a skill script runs. One call is one short-lived sandbox: it starts
 * clean, holds only `files`, sees no Harbourmaster secret, and is gone when the
 * call returns. Network is on. A failure of the script is an `exitCode`, not a
 * rejection. A rejection means the sandbox itself failed.
 */
export interface SkillScriptSandbox {
  run: (input: SandboxRunInput) => Promise<SandboxRunResult>;
}
