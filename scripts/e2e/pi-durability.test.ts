import { describe, expect, test } from "bun:test";

import { CloudError, type SeqEvent } from "./cloud.ts";
import type { OutageDeps, RunState, RunStatus } from "./cloud-outage.ts";
import {
  checkPins,
  PI_PACKAGES,
  type PinDeps,
  runUnsafe,
} from "./pi-durability.ts";

const EXACT = "1.2.3";
const START_MS = Date.parse("2026-10-17T10:00:00Z");
const LEASE_MS = 600_000;
const TOOL_CALL_MS = 1000;
const RESUMED_MS = 5000;
const INTERRUPTED_OUTPUT =
  "Tool harbourmaster_bash was interrupted and may have partially run";
const RERUN_OUTPUT = "ran-42\nexit code 0";

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
  /** True: after the restart Pi runs the tool again and it prints the marker. */
  reruns?: boolean;
}

/**
 * A run with one `harbourmaster_bash` call in miniature. The call shows up
 * one second after the offer. The server kill leaves the run stuck until the
 * restart. After the restart it streams for a few seconds and ends.
 */
const fakeUnsafe = (options: FakeOptions = {}) => {
  let clock = START_MS;
  let offeredAt: number | null = null;
  let status: RunStatus = "queued";
  let restarted = false;
  let resumedMs = 0;
  const callsTool = options.callsTool ?? true;
  const finalStatus = options.finalStatus ?? "done";
  const calls: string[] = [];
  const out: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  const toolResult = (output: string, seq: number): SeqEvent => ({
    payload: { ok: true, output, toolUseId: "call-1" },
    seq,
    type: "tool.result",
  });

  const deps: OutageDeps = {
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
          payload: { name: "harbourmaster_bash", toolUseId: "call-1" },
          seq: 1,
          type: "tool.call",
        });
      }
      if (called && options.answersBeforeKill) {
        events.push(toolResult("answered early", 2));
      }
      if (status === "done" && callsTool) {
        events.push(
          toolResult(options.reruns ? RERUN_OUTPUT : INTERRUPTED_OUTPUT, 2)
        );
      }
      return events;
    },
    killServer: () => {
      calls.push("kill");
      return Promise.resolve();
    },
    now: () => new Date(clock),
    out: (line) => out.push(line),
    reap: () => Promise.resolve([]),
    runOf: (): Promise<RunState> =>
      Promise.resolve({
        error: status === "failed" ? "Tool crashed" : null,
        leaseUntil: offeredAt === null ? null : iso(START_MS + LEASE_MS),
        resultText:
          status === "done" ? `tool failed: ${INTERRUPTED_OUTPUT}` : null,
        status,
      }),
    send: () => {
      status = "queued";
      return Promise.resolve("run-1");
    },
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
    const { calls, deps, out } = fakeUnsafe();
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
    const { deps } = fakeUnsafe({ reruns: true });
    expect(await failureOf(runUnsafe(deps))).toContain("ran the tool again");
  });

  test("fails when the tool answers before the kill", async () => {
    const { calls, deps } = fakeUnsafe({ answersBeforeKill: true });
    expect(await failureOf(runUnsafe(deps))).toContain(
      "the tool already answered"
    );
    expect(calls).toEqual(["offer run-1"]);
  });

  test("fails when the run never calls its tool", async () => {
    const { deps } = fakeUnsafe({ callsTool: false });
    expect(await failureOf(runUnsafe(deps))).toContain("never called its tool");
  });

  test("fails when the run ends failed after the restart", async () => {
    const { deps } = fakeUnsafe({ finalStatus: "failed" });
    expect(await failureOf(runUnsafe(deps))).toContain(
      "run run-1 is failed (Tool crashed) after the restart, expected done"
    );
  });
});
