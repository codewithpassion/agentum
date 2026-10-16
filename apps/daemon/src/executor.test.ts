import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaimResponse,
  CompleteRequest,
  RunEventInput,
} from "@repo/protocol/machine";
import type { Timers } from "./client.ts";
import type { CommandRunner } from "./command.ts";
import { type ExecuteRunDeps, executeRun, type QueryFn } from "./executor.ts";
import type { Logger } from "./log.ts";
import type { RunApi } from "./run-api.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CLAIM_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "protocol",
  "fixtures",
  "claim-response.json"
);
const MACHINE_ID = "mch_test";
const RUN_TOKEN = "hm_run_7Fq2KxR9mWt4LpZc1Ns8VbYd";
const CREDENTIAL = "hm_mach_secret_for_tests";

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

const claimWith = (
  change: (claim: ClaimResponse) => void = () => undefined
) => {
  const claim = readJson(CLAIM_FIXTURE) as ClaimResponse;
  claim.session = {
    id: claim.session.id,
    runtimeMachineId: null,
    runtimeRef: null,
  };
  change(claim);
  return claim;
};

/** What `tick` stands for in a scripted SDK stream: the 500 ms batch timer fires. */
const TICK = "tick";
type Step = SDKMessage | typeof TICK;

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
  exit(code: number | null) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const fakeTimers = () => {
  interface Pending {
    delay: number;
    fn: () => void;
    id: number;
    label: string;
  }
  let nextId = 0;
  let pending: Pending[] = [];
  const add = (delay: number, fn: () => void, label = "") => {
    nextId += 1;
    const timer = { delay, fn, id: nextId, label };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other.id !== timer.id);
    };
  };
  const timers: Timers = {
    after: (ms, fn, label) => add(ms, fn, label),
    every: (ms, fn, label) => add(ms, fn, label),
  };
  return {
    fire: (label: string) => {
      for (const timer of pending.filter((other) => other.label === label)) {
        timer.fn();
      }
    },
    has: (label: string) => pending.some((timer) => timer.label === label),
    timers,
  };
};

interface Harness {
  completions: { body: CompleteRequest; processExited: boolean }[];
  events: RunEventInput[][];
  heartbeat: { reject: unknown };
  lines: string[];
  optionsSeen: Options[];
  order: string[];
  proc: FakeProcess;
  run: CommandRunner;
  runCommands: string[][];
  sendStderr: (text: string) => void;
  timers: ReturnType<typeof fakeTimers>;
}

interface SetupOptions {
  claim?: ClaimResponse;
  claudeBinary?: string | null;
  /** Keeps the stream open after the script until an abort. */
  hang?: boolean;
  /** Keeps the process alive after an abort until the test lets it go. */
  holdExit?: boolean;
  /** `setMcpServers` answers only once the query is closed. */
  mcpHangsUntilClose?: boolean;
  script: Step[];
  singleUser?: boolean;
  /** Written to stderr once the process has started. */
  stderr?: string;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hm-exec-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

const abortError = () =>
  Object.assign(new Error("Claude Code process aborted by user"), {
    name: "AbortError",
  });

const setup = (setupOptions: SetupOptions) => {
  const claim = setupOptions.claim ?? claimWith();
  const timers = fakeTimers();
  const proc = new FakeProcess();
  const order: string[] = [];
  const optionsSeen: Options[] = [];
  const completions: Harness["completions"] = [];
  const events: RunEventInput[][] = [];
  const lines: string[] = [];
  const runCommands: string[][] = [];
  const heartbeat: Harness["heartbeat"] = { reject: undefined };
  let stderr: (text: string) => void = () => undefined;
  let closeQuery: () => void = () => undefined;

  const api: RunApi = {
    claim: () => Promise.reject(new Error("not used")),
    complete: (body) => {
      order.push(`complete:${body.status}`);
      completions.push({ body, processExited: proc.exitCode !== null });
      return Promise.resolve();
    },
    events: (batch) => {
      events.push(batch);
      return Promise.resolve();
    },
    heartbeat: () =>
      heartbeat.reject === undefined
        ? Promise.resolve()
        : Promise.reject(heartbeat.reject),
  };

  const queryFn: QueryFn = ({ options, prompt }) => {
    if (options === undefined) {
      throw new Error("the executor must pass options");
    }
    optionsSeen.push(options);
    const signal = options.abortController?.signal;
    const spawned = options.spawnClaudeCodeProcess?.({
      args: [],
      command: "claude",
      cwd: options.cwd,
      env: options.env ?? {},
      signal: signal ?? new AbortController().signal,
    });
    if (spawned === undefined) {
      throw new Error(
        "the executor must start Claude Code through the SDK hook"
      );
    }
    if (setupOptions.stderr !== undefined) {
      stderr(setupOptions.stderr);
    }
    signal?.addEventListener("abort", () => {
      proc.kill("SIGTERM");
      if (!setupOptions.holdExit) {
        proc.exit(null);
      }
    });

    async function* stream(): AsyncGenerator<SDKMessage> {
      const first = await (prompt as AsyncIterable<SDKUserMessage>)
        [Symbol.asyncIterator]()
        .next();
      const content = first.done ? "(none)" : first.value.message.content;
      order.push(`first-message:${String(content)}`);
      for (const step of setupOptions.script) {
        if (signal?.aborted) {
          throw abortError();
        }
        if (step === TICK) {
          timers.fire("event-batch");
          // Let the batch go out before the next message is pushed.
          // biome-ignore lint/performance/noAwaitInLoops: the stream plays its steps in order.
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          yield step;
        }
      }
      if (setupOptions.hang) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()));
        });
      }
      const gotResult = setupOptions.script.some(
        (step) => step !== TICK && step.type === "result"
      );
      proc.exit(gotResult ? 0 : 1);
    }

    const iterator = stream();
    const fakeQuery = {
      [Symbol.asyncIterator]: () => iterator,
      close: () => {
        order.push("close");
        closeQuery();
      },
      setMcpServers: (servers: Record<string, unknown>) => {
        order.push(`setMcpServers:${Object.keys(servers).join(",")}`);
        if (setupOptions.mcpHangsUntilClose) {
          return new Promise((resolve) => {
            closeQuery = () =>
              resolve({
                added: [],
                errors: { harbourmaster: "closed" },
                removed: [],
              });
          });
        }
        return Promise.resolve({
          added: Object.keys(servers),
          errors: {},
          removed: [],
        });
      },
    };
    return fakeQuery as unknown as Query;
  };

  const run: CommandRunner = (command) => {
    runCommands.push(command);
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
  };
  const log: Logger = {
    error: (message) => lines.push(message),
    info: (message) => lines.push(message),
  };
  const deps: ExecuteRunDeps = {
    claim,
    config: {
      claudeBinary:
        setupOptions.claudeBinary === undefined
          ? "/usr/local/bin/claude"
          : setupOptions.claudeBinary,
      credential: CREDENTIAL,
      machineId: MACHINE_ID,
      singleUser: setupOptions.singleUser ?? true,
    },
    createApi: () => api,
    daemonHome: home,
    env: {
      ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      HM_CREDENTIAL: CREDENTIAL,
      HOME: "/home/dom",
      PATH: "/usr/bin",
    },
    log,
    queryFn,
    run,
    spawnProcessFor: (onStderr) => {
      stderr = onStderr;
      return () => proc as unknown as SpawnedProcess;
    },
    timers: timers.timers,
  };
  const execution = executeRun(deps);
  const harness: Harness = {
    completions,
    events,
    heartbeat,
    lines,
    optionsSeen,
    order,
    proc,
    run,
    runCommands,
    sendStderr: (text) => stderr(text),
    timers,
  };
  return { ...harness, claim, execution };
};

const toolRun = readJson(join(FIXTURES, "tool-run", "sdk-messages.json")) as [
  SDKMessage,
  ...SDKMessage[],
];
const [INIT] = toolRun;
/** Ticks after the first assistant message, mid-run, and at the end, so the batches differ. */
const toolRunScript = (): Step[] => {
  const steps: Step[] = [];
  toolRun.forEach((message, index) => {
    steps.push(message);
    if (index === 2 || index === 5) {
      steps.push(TICK);
    }
  });
  return steps;
};

/** The stored golden; with UPDATE_GOLDENS set it is first rewritten from `actual`. */
const goldenFor = <T>(name: string, actual: T): T => {
  const path = join(FIXTURES, "tool-run", name);
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
  }
  return readJson(path) as T;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls without a loop, so a test fails by timeout and not by hanging. */
const until = async (check: () => boolean): Promise<void> => {
  if (check()) {
    return;
  }
  await sleep(1);
  await until(check);
};

describe("a run that uses tools", () => {
  test("the event batches and the completion match the goldens", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.events).toEqual(goldenFor("events.json", run.events));
    const bodies = run.completions.map((entry) => entry.body);
    expect(bodies).toEqual(goldenFor("complete.json", bodies));
  });

  test("the completion is posted after the process exits, and once", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.completions).toHaveLength(1);
    expect(run.completions[0]?.processExited).toBe(true);
  });

  test("the heartbeat and the batch timer stop when the run ends", async () => {
    const run = setup({ script: toolRunScript() });
    expect(run.timers.has("heartbeat")).toBe(true);
    await run.execution.finished;
    expect(run.timers.has("heartbeat")).toBe(false);
    expect(run.timers.has("event-batch")).toBe(false);
  });
});

describe("the options passed to query", () => {
  test("carry the permission mode, strict MCP, the instructions and no MCP servers", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const [options] = run.optionsSeen;
    expect(options).toBeDefined();
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.settingSources).toEqual(["project"]);
    expect(options?.systemPrompt).toEqual({
      append: run.claim.instructions,
      preset: "claude_code",
      type: "preset",
    });
    expect(options?.model).toBe(run.claim.agent.model);
    expect(options?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options?.canUseTool).toBeUndefined();
    expect(options && "mcpServers" in options).toBe(false);
  });

  test("the env is filtered and holds no run token", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const env = run.optionsSeen[0]?.env ?? {};
    expect(env).toEqual({ HOME: "/home/dom", PATH: "/usr/bin" });
    expect(JSON.stringify(run.optionsSeen[0])).not.toContain("hm_run_");
  });

  test("the budget comes from the agent config", async () => {
    const claim = claimWith((c) => {
      c.agent.runtimeConfig = { maxBudgetUsd: 1.5 };
    });
    const run = setup({ claim, script: toolRunScript() });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.maxBudgetUsd).toBe(1.5);
    const other = setup({ script: toolRunScript() });
    await other.execution.finished;
    expect(other.optionsSeen[0] && "maxBudgetUsd" in other.optionsSeen[0]).toBe(
      false
    );
  });

  test("the working directory is under the agent's home layout", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.cwd).toBe(
      join(
        home,
        "harbourmaster",
        run.claim.run.workspaceId,
        run.claim.run.agentId,
        "work"
      )
    );
  });

  test("multi-user mode prepares the directory through sudo as hm-agent", async () => {
    const run = setup({ script: toolRunScript(), singleUser: false });
    await run.execution.finished;
    expect(run.runCommands.map((command) => command.slice(0, 5))).toEqual([
      ["sudo", "-n", "-u", "hm-agent", "/bin/mkdir"],
      ["sudo", "-n", "-u", "hm-agent", "/bin/rm"],
    ]);
    expect(
      run.optionsSeen[0]?.cwd?.startsWith("/home/hm-agent/harbourmaster/")
    ).toBe(true);
  });
});

describe("the order of the first message", () => {
  test("setMcpServers gets the claim's map before the first message", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.order.slice(0, 2)).toEqual([
      "setMcpServers:harbourmaster",
      `first-message:${run.claim.run.inputText}`,
    ]);
  });
});

describe("resume", () => {
  const withSession = (machine: string | null, ref: string | null) =>
    claimWith((c) => {
      c.session = {
        id: c.session.id,
        runtimeMachineId: machine,
        runtimeRef: ref,
      };
    });

  test("is passed when the session's machine is this one", async () => {
    const run = setup({
      claim: withSession(MACHINE_ID, "sess-1"),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.resume).toBe("sess-1");
  });

  test("is left out for another machine", async () => {
    const run = setup({
      claim: withSession("mch_other", "sess-1"),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0] && "resume" in run.optionsSeen[0]).toBe(false);
  });

  test("is left out when there is no session yet", async () => {
    const run = setup({
      claim: withSession(MACHINE_ID, null),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0] && "resume" in run.optionsSeen[0]).toBe(false);
  });
});

describe("aborting", () => {
  const untilStarted = (run: ReturnType<typeof setup>) =>
    until(() => run.order.some((entry) => entry.startsWith("first-message")));

  test("a heartbeat 409 kills the process and posts aborted only after it exits", async () => {
    const run = setup({ hang: true, holdExit: true, script: [INIT] });
    await untilStarted(run);
    run.heartbeat.reject = Object.assign(new Error("Run is not running"), {
      status: 409,
    });
    run.timers.fire("heartbeat");
    await sleep(10);
    expect(run.proc.signals).toContain("SIGTERM");
    expect(run.completions).toHaveLength(0);
    run.proc.exit(143);
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.completions[0]?.processExited).toBe(true);
  });

  test("a stuck process gets SIGKILL after the grace period", async () => {
    const run = setup({ hang: true, holdExit: true, script: [INIT] });
    await untilStarted(run);
    run.execution.abort("relay connection replaced");
    await sleep(10);
    // The SDK's SIGTERM did not help: the executor waits, then escalates.
    expect(run.timers.has("kill")).toBe(true);
    expect(run.completions).toHaveLength(0);
    run.timers.fire("kill");
    expect(run.proc.signals.at(-1)).toBe("SIGKILL");
    run.proc.exit(137);
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
  });

  test("an abort while the MCP servers are being handed over still posts aborted", async () => {
    const run = setup({
      hang: true,
      mcpHangsUntilClose: true,
      script: toolRunScript(),
    });
    await until(() => run.order.includes("setMcpServers:harbourmaster"));
    run.execution.abort("relay connection replaced");
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.order).toContain("close");
  });

  test("an abort before the run started posts aborted without starting Claude Code", async () => {
    const run = setup({ hang: true, script: toolRunScript() });
    run.execution.abort("cancelled");
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.order).not.toContain(`first-message:${run.claim.run.inputText}`);
  });
});

describe("failures", () => {
  test("an error result posts failed with the error and the session", async () => {
    const result = {
      ...(toolRun.at(-1) as object),
      errors: ["Budget of $0.01 exceeded"],
      is_error: true,
      subtype: "error_max_budget_usd",
    } as unknown as SDKMessage;
    const run = setup({ script: [INIT, result] });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toBe(
      "Budget of $0.01 exceeded"
    );
  });

  test("a stream with no result posts failed and masks the run token from stderr", async () => {
    const run = setup({
      script: [INIT],
      stderr: `boom ${RUN_TOKEN} and ${CREDENTIAL}\n`,
    });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain(
      "boom [secret:run_token]"
    );
    expect(JSON.stringify(run.completions)).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(run.completions)).not.toContain(CREDENTIAL);
    expect(run.lines.join("\n")).not.toContain(RUN_TOKEN);
  });

  test("a machine without a claude binary fails the run with a clear error", async () => {
    const run = setup({ claudeBinary: null, script: [] });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain(
      "claude binary"
    );
    expect(run.optionsSeen).toHaveLength(0);
  });
});
