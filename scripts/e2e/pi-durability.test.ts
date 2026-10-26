import { describe, expect, test } from "bun:test";

import { CloudError, type SeqEvent } from "./cloud.ts";
import type { OutageDeps, RunState, RunStatus } from "./cloud-outage.ts";
import {
  checkPins,
  GATED_RAN_TEXT,
  PI_PACKAGES,
  type PinDeps,
  runSafe,
  runUnsafe,
  runWaiting,
} from "./pi-durability.ts";

const EXACT = "1.2.3";
const START_MS = Date.parse("2026-10-17T10:00:00Z");
const LEASE_MS = 600_000;
const TOOL_CALL_MS = 1000;
const RESUMED_MS = 5000;
const UNSAFE_TOOL = "harbourmaster_bash";
const SAFE_TOOL = "dev_slow_read";
const INTERRUPTED_OUTPUT = `Tool ${UNSAFE_TOOL} was interrupted and may have partially run`;
const RERUN_OUTPUT = "ran-42\nexit code 0";
const SAFE_OUTPUT = "slow read done, started 2 times";

type Versions = Record<string, string | undefined>;

const exactVersions = (): Versions =>
  Object.fromEntries(PI_PACKAGES.map((name) => [name, EXACT]));

const pinDeps = (
  declared: Versions,
  installed: Versions = declared
): PinDeps => ({
  declared: (name) => declared[name],
  installed: (name) => installed[name],
});

/** The message `checkPins` throws, or a note when it does not throw a CloudError. */
const pinFailure = (deps: PinDeps): string => {
  try {
    checkPins(deps);
    return "no error";
  } catch (error) {
    return error instanceof CloudError
      ? error.message
      : `not a CloudError: ${String(error)}`;
  }
};

interface FakeOptions {
  /** True: the tool has answered before the server is killed. */
  answersBeforeKill?: boolean;
  /** False: Pi never calls its tool. */
  callsTool?: boolean;
  /** The status the run ends in after the restart. */
  finalStatus?: RunStatus;
  /** The output of the tool call after the restart. Defaults to the interrupted text. */
  output?: string;
  /** The tool the run calls. Defaults to the unsafe bash tool. */
  toolName?: string;
}

/**
 * A run with one tool call in miniature. The call shows up one second after
 * the offer. The server kill leaves the run stuck until the restart. After the
 * restart it streams for a few seconds and ends.
 */
const fakeRun = (options: FakeOptions = {}) => {
  let clock = START_MS;
  let offeredAt: number | null = null;
  let status: RunStatus = "queued";
  let restarted = false;
  let resumedMs = 0;
  const callsTool = options.callsTool ?? true;
  const finalStatus = options.finalStatus ?? "done";
  const finalOutput = options.output ?? INTERRUPTED_OUTPUT;
  const toolName = options.toolName ?? UNSAFE_TOOL;
  const calls: string[] = [];
  const out: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  const toolResult = (output: string, seq: number): SeqEvent => ({
    payload: { ok: true, output, toolUseId: "call-1" },
    seq,
    type: "tool.result",
  });

  const deps: OutageDeps = {
    answer: () => Promise.resolve(),
    drive: (action, runId) => {
      calls.push(`${action} ${runId}`);
      offeredAt = clock;
      status = "running";
      return Promise.resolve();
    },
    eventsOf: (): SeqEvent[] => {
      const events: SeqEvent[] = [];
      const called =
        callsTool && offeredAt !== null && clock >= offeredAt + TOOL_CALL_MS;
      if (called) {
        events.push({
          payload: { name: toolName, toolUseId: "call-1" },
          seq: 1,
          type: "tool.call",
        });
      }
      if (called && options.answersBeforeKill) {
        events.push(toolResult("answered early", 2));
      }
      if (status === "done" && callsTool) {
        events.push(toolResult(finalOutput, 2));
      }
      return events;
    },
    killServer: () => {
      calls.push("kill");
      return Promise.resolve();
    },
    now: () => new Date(clock),
    out: (line) => out.push(line),
    pendingRequestId: () => undefined,
    reap: () => Promise.resolve([]),
    runOf: (): Promise<RunState> =>
      Promise.resolve({
        error: status === "failed" ? "Tool crashed" : null,
        leaseUntil: offeredAt === null ? null : iso(START_MS + LEASE_MS),
        resultText: status === "done" ? `tool said: ${finalOutput}` : null,
        status,
      }),
    send: () => {
      status = "queued";
      return Promise.resolve("run-1");
    },
    setRule: () => Promise.resolve(),
    sleep: (ms) => {
      clock += ms;
      if (restarted && status === "running") {
        resumedMs += ms;
        if (resumedMs >= RESUMED_MS) {
          status = finalStatus;
        }
      }
      return Promise.resolve();
    },
    startServer: () => {
      calls.push("start");
      restarted = true;
      return Promise.resolve();
    },
  };
  return { calls, deps, out };
};

interface WaitingOptions {
  /** True: the run ends without ever opening a request. */
  endsWithoutWaiting?: boolean;
  /** True: the pending request is gone once the server restarts. */
  forgetsRequest?: boolean;
  /** The output of the gated tool. Defaults to one run. */
  output?: string;
}

const REQUEST_ID = "req-1";
const GATED_TOOL_NAME = "dev_gated";

/**
 * A gated run in miniature. One second after the offer the run calls its tool
 * and opens one request, then waits. An answer resumes it, and after
 * RESUMED_MS the tool answers and the run ends. The clock only moves the run
 * while the server is up.
 */
const fakeWaiting = (options: WaitingOptions = {}) => {
  let clock = START_MS;
  let status: RunStatus = "queued";
  let up = true;
  let offeredAt: number | null = null;
  let resumedAt: number | null = null;
  let pending: string | undefined;
  const output = options.output ?? GATED_RAN_TEXT;
  const events: SeqEvent[] = [];
  const calls: string[] = [];
  const out: string[] = [];

  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push({ payload, seq: events.length + 1, type });
  };

  const tick = () => {
    if (!up) {
      return;
    }
    if (
      status === "running" &&
      resumedAt === null &&
      offeredAt !== null &&
      clock >= offeredAt + TOOL_CALL_MS
    ) {
      if (options.endsWithoutWaiting) {
        status = "done";
        return;
      }
      emit("tool.call", { name: GATED_TOOL_NAME, toolUseId: "call-1" });
      emit("request.opened", { requestId: REQUEST_ID });
      emit("run.waiting", {});
      pending = REQUEST_ID;
      status = "waiting";
    }
    if (
      status === "running" &&
      resumedAt !== null &&
      clock >= resumedAt + RESUMED_MS
    ) {
      emit("tool.result", { ok: true, output, toolUseId: "call-1" });
      status = "done";
    }
  };

  const deps: OutageDeps = {
    answer: (requestId, decision) => {
      calls.push(`answer ${requestId} ${decision}`);
      if (requestId === pending) {
        pending = undefined;
        emit("request.answered", { decision });
        emit("run.resumed", {});
        resumedAt = clock;
        status = "running";
      }
      return Promise.resolve();
    },
    drive: (action, runId) => {
      calls.push(`${action} ${runId}`);
      offeredAt = clock;
      status = "running";
      return Promise.resolve();
    },
    eventsOf: () => [...events],
    eventTypesOf: () => events.map((event) => event.type),
    killServer: () => {
      calls.push("kill");
      up = false;
      return Promise.resolve();
    },
    now: () => new Date(clock),
    out: (line) => out.push(line),
    pendingRequestId: () => pending,
    reap: () => Promise.resolve([]),
    runOf: (): Promise<RunState> =>
      Promise.resolve({
        error: null,
        leaseUntil: null,
        resultText:
          status === "done" && resumedAt !== null
            ? `tool said: ${output}`
            : null,
        status,
      }),
    send: () => {
      status = "queued";
      return Promise.resolve("run-1");
    },
    setRule: (toolKey, mode) => {
      calls.push(`rule ${toolKey} ${mode}`);
      return Promise.resolve();
    },
    sleep: (ms) => {
      clock += ms;
      tick();
      return Promise.resolve();
    },
    startServer: () => {
      calls.push("start");
      up = true;
      if (options.forgetsRequest) {
        pending = undefined;
      }
      return Promise.resolve();
    },
  };
  return { calls, deps, out };
};

/** The message of the CloudError `run` rejects with, or a note when it does not reject with one. */
const failureOf = (run: Promise<void>): Promise<string> =>
  run.then(
    () => "no error",
    (error: unknown) =>
      error instanceof CloudError
        ? error.message
        : `not a CloudError: ${String(error)}`
  );

describe("checkPins", () => {
  test("passes and returns name@version lines when every pin is exact and installed", () => {
    const lines = checkPins(pinDeps(exactVersions()));
    expect(lines).toEqual(PI_PACKAGES.map((name) => `${name}@${EXACT}`));
  });

  test("fails when a package is declared with a range", () => {
    const declared = { ...exactVersions(), agents: "^1.3.0" };
    const installed = { ...exactVersions(), agents: "1.3.0" };
    expect(pinFailure(pinDeps(declared, installed))).toContain(
      'agents is "^1.3.0" in apps/web/package.json, expected an exact version'
    );
  });

  test("fails when the installed version differs from the declared one", () => {
    const installed = { ...exactVersions(), typebox: "1.2.4" };
    expect(pinFailure(pinDeps(exactVersions(), installed))).toContain(
      `typebox is pinned to ${EXACT} but 1.2.4 is installed`
    );
  });

  test("fails when a package is missing from the declared versions", () => {
    const declared = { ...exactVersions(), "@earendil-works/chord": undefined };
    expect(pinFailure(pinDeps(declared))).toContain(
      '@earendil-works/chord is "undefined" in apps/web/package.json'
    );
  });
});

describe("runUnsafe", () => {
  test("passes when the interrupted tool is not run again and the model sees it", async () => {
    const { calls, deps, out } = fakeRun();
    await runUnsafe(deps);
    expect(out.map((line) => line.slice(0, 4))).toEqual([
      "ok 1",
      "ok 2",
      "ok 3",
      "ok 4",
    ]);
    expect(calls).toEqual(["offer run-1", "kill", "start"]);
  });

  test("fails when Pi runs the tool again after the restart", async () => {
    const { deps } = fakeRun({ output: RERUN_OUTPUT });
    expect(await failureOf(runUnsafe(deps))).toContain("ran the tool again");
  });

  test("fails when the tool answers before the kill", async () => {
    const { calls, deps } = fakeRun({ answersBeforeKill: true });
    expect(await failureOf(runUnsafe(deps))).toContain(
      "the tool already answered"
    );
    expect(calls).toEqual(["offer run-1"]);
  });

  test("fails when the run never calls its tool", async () => {
    const { deps } = fakeRun({ callsTool: false });
    expect(await failureOf(runUnsafe(deps))).toContain("never called its tool");
  });

  test("fails when the run ends failed after the restart", async () => {
    const { deps } = fakeRun({ finalStatus: "failed" });
    expect(await failureOf(runUnsafe(deps))).toContain(
      "run run-1 is failed (Tool crashed) after the restart, expected done"
    );
  });
});

describe("runWaiting", () => {
  test("passes when the request survives the restart and the tool runs once", async () => {
    const { calls, deps, out } = fakeWaiting();
    await runWaiting(deps);
    expect(out.map((line) => line.slice(0, 4))).toEqual([
      "ok 1",
      "ok 2",
      "ok 3",
      "ok 4",
      "ok 5",
      "ok 6",
    ]);
    expect(calls).toEqual([
      "rule dev_gated ask",
      "offer run-1",
      "kill",
      "start",
      "answer req-1 allow_once",
    ]);
  });

  test("fails when the tool ran twice", async () => {
    const { deps } = fakeWaiting({ output: "gated ran 2 times" });
    expect(await failureOf(runWaiting(deps))).toContain(
      'waiting: expected the gated tool to run once (gated ran 1 times), got "gated ran 2 times"'
    );
  });

  test("fails when the run ends without ever waiting", async () => {
    const { deps } = fakeWaiting({ endsWithoutWaiting: true });
    expect(await failureOf(runWaiting(deps))).toContain(
      "waiting: run run-1 is done before it waited for an answer"
    );
  });

  test("fails when the request vanishes after the restart", async () => {
    const { calls, deps } = fakeWaiting({ forgetsRequest: true });
    expect(await failureOf(runWaiting(deps))).toContain(
      "waiting: request req-1 is no longer pending after the restart"
    );
    expect(calls).not.toContain("answer req-1 allow_once");
  });
});

describe("runSafe", () => {
  test("passes when the tool runs again and the model answers with the second start", async () => {
    const { calls, deps, out } = fakeRun({
      output: SAFE_OUTPUT,
      toolName: SAFE_TOOL,
    });
    await runSafe(deps);
    expect(out.map((line) => line.slice(0, 4))).toEqual([
      "ok 1",
      "ok 2",
      "ok 3",
      "ok 4",
    ]);
    expect(calls).toEqual(["offer run-1", "kill", "start"]);
  });

  test("fails when the output carries the interrupted text", async () => {
    const { deps } = fakeRun({
      output: INTERRUPTED_OUTPUT,
      toolName: SAFE_TOOL,
    });
    expect(await failureOf(runSafe(deps))).toContain(
      "safe tool: Pi marked the tool as interrupted"
    );
  });

  test("fails when the output says the tool started once", async () => {
    const { deps } = fakeRun({
      output: "slow read done, started 1 times",
      toolName: SAFE_TOOL,
    });
    expect(await failureOf(runSafe(deps))).toContain(
      'safe tool: expected the tool to run again (started 2 times), got "slow read done, started 1 times"'
    );
  });

  test("fails when the run ends failed after the restart", async () => {
    const { deps } = fakeRun({
      finalStatus: "failed",
      output: SAFE_OUTPUT,
      toolName: SAFE_TOOL,
    });
    expect(await failureOf(runSafe(deps))).toContain(
      "safe tool: run run-1 is failed (Tool crashed) after the restart, expected done"
    );
  });

  test("fails when the tool answers before the kill", async () => {
    const { calls, deps } = fakeRun({
      answersBeforeKill: true,
      output: SAFE_OUTPUT,
      toolName: SAFE_TOOL,
    });
    expect(await failureOf(runSafe(deps))).toContain(
      "safe tool: before the kill: the tool already answered"
    );
    expect(calls).toEqual(["offer run-1"]);
  });
});
