/**
 * `exec` is the operation the remote backends exist for: a real shell, not the
 * Durable Object's degraded one. It is also the only operation that can misbehave,
 * so three things are non-negotiable here.
 *
 * - **The whole process group dies at the deadline.** Killing the `sh` that was
 *   spawned leaves `sleep 100 &` behind holding the container; the command is
 *   therefore started in its own session (`setsid`) and the deadline kills the
 *   group. The report mirrors `timeout(1)`: exit code 124 and a note on stderr.
 * - **Output is counted in full and kept in part.** A runaway `yes` must not
 *   fill this process's memory on its way to being truncated, so the streams are
 *   drained continuously and only the first `TOOL_OUTPUT_MAX_BYTES` are retained.
 * - **One command at a time.** The Durable Object computer is single-threaded by
 *   construction and agents are written against that; a second exec waits.
 */

import {
  TOOL_OUTPUT_MAX_BYTES,
  truncateBytes,
  withTruncationNote,
} from "./output";
import { resolveInRoot } from "./paths";
import type { ExecResult } from "./protocol";

/** What an omitted `timeoutMs` means; matches the web's `EXEC_TIMEOUT_MS`. */
const EXEC_DEFAULT_MS = 30_000;

/** What `timeout(1)` reports when it had to kill the command. */
const TIMEOUT_EXIT_CODE = 124;

/** A command killed by a signal has no exit code; do not report success. */
const SIGNALLED_EXIT_CODE = 1;

/**
 * Present on every Debian image this ships as, absent on some developer
 * machines. Without it the deadline can only reach the shell itself, which is
 * still better than letting the command run forever.
 */
const SETSID = Bun.which("setsid");

export interface ExecRequest {
  command: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
}

const commandLine = (command: string): string[] =>
  // `-w` is inert while the child is not already a process-group leader (setsid
  // then execs in place), and keeps the wait honest if that ever changes.
  SETSID ? [SETSID, "-w", "sh", "-c", command] : ["sh", "-c", command];

const clampTimeout = (raw: unknown, maxMs: number): number => {
  const requested =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : EXEC_DEFAULT_MS;
  return Math.min(requested, maxMs);
};

const drain = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> => {
  const head = new Uint8Array(maxBytes);
  let kept = 0;
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (kept < maxBytes) {
      const take = Math.min(chunk.byteLength, maxBytes - kept);
      head.set(chunk.subarray(0, take), kept);
      kept += take;
    }
  }
  return withTruncationNote(
    truncateBytes(head.subarray(0, kept), total, maxBytes)
  );
};

const killGroup = (pid: number, fallback: () => void): void => {
  if (!SETSID) {
    fallback();
    return;
  }
  try {
    // A negative pid addresses the process group, which is the whole point of
    // having started the command in its own session.
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never became a group leader: the direct kill is a no-op
    // in the first case and the only option in the second.
    fallback();
  }
};

const runExec = async (
  root: string,
  maxMs: number,
  request: ExecRequest
): Promise<ExecResult> => {
  if (typeof request.command !== "string" || request.command.trim() === "") {
    return { ok: false, reason: "A command is required." };
  }

  let cwd = root;
  if (request.cwd !== undefined && request.cwd !== null) {
    const target = await resolveInRoot(root, request.cwd);
    if (!target.ok) {
      return target;
    }
    cwd = target.abs;
  }

  const timeoutMs = clampTimeout(request.timeoutMs, maxMs);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(commandLine(request.command), {
      cwd,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, () => child.kill("SIGKILL"));
  }, timeoutMs);

  // Both streams are drained at once: reading one to the end first deadlocks as
  // soon as the other fills its pipe buffer.
  const [stdout, stderr, code] = await Promise.all([
    drain(child.stdout, TOOL_OUTPUT_MAX_BYTES),
    drain(child.stderr, TOOL_OUTPUT_MAX_BYTES),
    child.exited,
  ]);
  clearTimeout(deadline);

  if (timedOut) {
    return {
      exitCode: TIMEOUT_EXIT_CODE,
      ok: true,
      stderr: `${stderr}\n[timed out after ${timeoutMs}ms; the command and everything it started were killed]`,
      stdout,
    };
  }
  return { exitCode: code ?? SIGNALLED_EXIT_CODE, ok: true, stderr, stdout };
};

export type ExecRunner = (request: ExecRequest) => Promise<ExecResult>;

/**
 * One runner per daemon, shared by both transports, so "one command at a time"
 * holds whether the requests arrive over HTTP or over the socket. The chain is
 * the entire queue: each call waits on the previous one's settlement.
 */
export const createExecRunner = (root: string, maxMs: number): ExecRunner => {
  let queue: Promise<unknown> = Promise.resolve();

  return (request) => {
    const running = queue.then(() => runExec(root, maxMs, request));
    // `runExec` answers with `{ ok: false }` rather than throwing, but a bug
    // that escapes it must not wedge the queue for the life of the process.
    queue = running.catch(() => undefined);
    return running;
  };
};
