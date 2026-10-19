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
  /** Variables to set for the script, read as `process.env.NAME`. */
  env?: Record<string, string>;
  /** Every file of the skill. */
  files: SandboxFile[];
  /** When true, the backend gives the script the platform host (see `script-host-api.ts`): the `library` global, a `fetch` that goes through the platform's fetcher, and no direct network. Then `proxy` and `env` are not used. */
  hosted?: boolean;
  /** What the caller shows of each of stdout and stderr. A backend keeps at least this much of each, and may cap far above it to protect its own memory. */
  maxOutputBytes: number;
  /** When true, the backend routes the script's outgoing requests through the platform's outbound proxy, which adds credentials for hosts the agent has rules for. */
  proxy?: boolean;
  /** The name of the skill, which is also its folder. A backend with a file system of its own places `files` in that folder. */
  skill: string;
  /** Text the script reads as the global `stdin`. Only used when `hosted` is true. */
  stdin?: string;
  /** Wall time for the run. When it passes, a backend gives up on the script and reports exit code 124. */
  timeoutMs: number;
}

export interface SandboxRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Where a skill script runs. One call is one short-lived sandbox: it starts
 * clean, holds only `files`, and is gone when the
 * call returns. Network is on. A run holds no secret except what `env` gives
 * it. A failure of the script is an `exitCode`, not a rejection. A rejection
 * means the sandbox itself failed.
 */
export interface SkillScriptSandbox {
  run: (input: SandboxRunInput) => Promise<SandboxRunResult>;
}

/** The exit code of `timeout(1)`, which models know. Reported when a run passes its time. */
export const TIMEOUT_EXIT_CODE = 124;
