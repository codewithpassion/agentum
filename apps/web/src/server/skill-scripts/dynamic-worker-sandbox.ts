/**
 * Runs a skill script in a Dynamic Worker (Worker Loader): a fresh isolate for
 * each call, gone when the call returns. It gets only the `env` the run names,
 * so it holds no binding or token of ours. It has the network. When the run
 * asks for `proxy`, `outbound` supplies the `globalOutbound` that adds the
 * agent's credentials to requests, so the isolate never holds them. Without
 * `proxy` it has no `globalOutbound`. The choice is in
 * `docs/reviews/tasks/C.12.md`.
 */

import {
  type SandboxRunInput,
  type SandboxRunResult,
  type SkillScriptSandbox,
  TIMEOUT_EXIT_CODE,
} from "./sandbox-port.ts";
import { buildModules } from "./script-bundle.ts";

/** From 2026-08-04 `nodejs_compat` is on by default, which `process` and `node:util` in the harness need. */
const COMPATIBILITY_DATE = "2026-08-19";
const HARNESS = "__harness.js";
/** Outbound requests per run. */
const MAX_SUBREQUESTS = 50;
const CPU_LIMIT_MESSAGE = /CPU time limit/i;
/** What the harness keeps of each stream, so a script that prints forever cannot fill the isolate. */
const HARNESS_STREAM_BYTES = 1024 * 1024;

/**
 * The module the Worker starts from. `run` points `process.argv`, `console`
 * and `process.exit` at the run, imports the entry and calls its function.
 */
const HARNESS_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { format } from "node:util";

class Exit extends Error {
  constructor(code) {
    super("exit");
    this.code = code;
  }
}

const encoder = new TextEncoder();
const stream = (limit) => {
  const parts = [];
  let kept = 0;
  return {
    text: () => parts.join(""),
    write: (text) => {
      const room = limit - kept;
      if (room <= 0) return;
      const bytes = encoder.encode(text).byteLength;
      parts.push(bytes <= room ? text : text.slice(0, room));
      kept += Math.min(bytes, room);
    },
  };
};

export class Runner extends WorkerEntrypoint {
  async run(entry, args, limit) {
    const out = stream(limit);
    const err = stream(limit);
    const line = (target) => (...values) => target.write(format(...values) + "\\n");
    console.log = console.info = console.debug = line(out);
    console.warn = console.error = line(err);
    process.stdout.write = (text) => (out.write(String(text)), true);
    process.stderr.write = (text) => (err.write(String(text)), true);
    process.argv = ["bun", "/" + entry, ...args];
    process.exit = (code) => {
      throw new Exit(Number.isInteger(Number(code)) ? Number(code) : 0);
    };
    let exitCode = 0;
    try {
      const module = await import("./" + entry);
      await module.default();
    } catch (error) {
      if (error instanceof Exit) {
        exitCode = error.code;
      } else {
        exitCode = 1;
        err.write(String((error && error.stack) || error) + "\\n");
      }
    }
    return { exitCode, stderr: err.text(), stdout: out.text() };
  }
}

export default {
  fetch: () => new Response("not an endpoint", { status: 404 }),
};
`;

const failure = (stderr: string, exitCode = 1): SandboxRunResult => ({
  exitCode,
  stderr: `${stderr}\n`,
  stdout: "",
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Resolves to `undefined` after `ms`, and gives the timer back so the caller can clear it. */
const timer = (ms: number) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    handle = setTimeout(() => resolve(undefined), ms);
  });
  return { clear: () => clearTimeout(handle), expired };
};

export const dynamicWorkerSandbox = (
  loader: WorkerLoader,
  outbound?: () => Fetcher
): SkillScriptSandbox => ({
  run: async (input: SandboxRunInput): Promise<SandboxRunResult> => {
    let modules: ReturnType<typeof buildModules>;
    try {
      modules = buildModules(input.files, input.entry);
    } catch (error) {
      return failure(messageOf(error));
    }
    const worker = loader.load({
      compatibilityDate: COMPATIBILITY_DATE,
      env: input.env ?? {},
      limits: { cpuMs: input.timeoutMs, subRequests: MAX_SUBREQUESTS },
      mainModule: HARNESS,
      modules: { ...modules, [HARNESS]: { js: HARNESS_SOURCE } },
      ...(input.proxy === true && outbound !== undefined
        ? { globalOutbound: outbound() }
        : {}),
    });
    const runner = worker.getEntrypoint("Runner") as unknown as {
      run: (
        entry: string,
        args: string[],
        limit: number
      ) => Promise<SandboxRunResult>;
    };
    const wall = timer(input.timeoutMs);
    try {
      const finished = await Promise.race([
        runner.run(input.entry, input.args, HARNESS_STREAM_BYTES),
        wall.expired,
      ]);
      if (finished === undefined) {
        return failure(
          `timed out after ${input.timeoutMs / 1000} s`,
          TIMEOUT_EXIT_CODE
        );
      }
      return finished;
    } catch (error) {
      const message = messageOf(error);
      return CPU_LIMIT_MESSAGE.test(message)
        ? failure(`exceeded the CPU time limit: ${message}`, TIMEOUT_EXIT_CODE)
        : failure(message);
    } finally {
      wall.clear();
    }
  },
});
