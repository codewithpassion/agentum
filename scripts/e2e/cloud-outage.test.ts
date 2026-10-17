import { describe, expect, test } from "bun:test";

import { CloudError, type SeqEvent } from "./cloud.ts";
import {
  type OutageDeps,
  type RunState,
  type RunStatus,
  runOutage,
} from "./cloud-outage.ts";

const TEN_MINUTES_MS = 600_000;
const HEARTBEAT_MS = 30_000;
const RESUMED_STREAM_MS = 30_000;
const START_MS = Date.parse("2026-10-17T10:00:00Z");

interface FakeOptions {
  /** The status the run ends in after the restart. */
  finalStatus?: RunStatus;
  /** False: the object never heartbeats after the restart. */
  heartbeats?: boolean;
  leaseMs?: number;
  /** The `ok` of the tool result after the restart. */
  toolOk?: boolean;
}

/**
 * A dev server and its run in miniature. The run streams while the server is
 * up and heartbeats its lease every 30 s. The reaper ends it once the lease
 * passes, and after a restart it streams for 30 s more and ends.
 */
const fakeOutage = (options: FakeOptions = {}) => {
  let clock = START_MS;
  const leaseMs = options.leaseMs ?? TEN_MINUTES_MS;
  let status: RunStatus = "queued";
  let leaseUntil: string | null = null;
  let up = false;
  let restarted = false;
  let lastBeat = START_MS;
  let resumedMs = 0;
  const calls: string[] = [];
  const out: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  const deps: OutageDeps = {
    drive: (action, runId) => {
      calls.push(`${action} ${runId}`);
      status = "running";
      leaseUntil = iso(clock + leaseMs);
      lastBeat = clock;
      return Promise.resolve();
    },
    eventsOf: (): SeqEvent[] =>
      status === "done"
        ? [
            {
              payload: {
                ok: options.toolOk ?? true,
                output: "after-the-outage",
                toolUseId: "call-1",
              },
              seq: 2,
              type: "tool.result",
            },
          ]
        : [],
    killServer: () => {
      calls.push("kill");
      up = false;
      return Promise.resolve();
    },
    now: () => new Date(clock),
    out: (line) => out.push(line),
    reap: () => {
      calls.push("reap");
      if (
        status === "running" &&
        leaseUntil !== null &&
        Date.parse(leaseUntil) < clock
      ) {
        status = "interrupted";
        return Promise.resolve(["run-1"]);
      }
      return Promise.resolve([]);
    },
    runOf: (): Promise<RunState> =>
      Promise.resolve({
        error: status === "interrupted" ? "Lease expired" : null,
        leaseUntil,
        resultText:
          status === "done" ? "tool said: echo after-the-outage" : null,
        status,
      }),
    send: () => {
      status = "queued";
      return Promise.resolve("run-1");
    },
    sleep: (ms) => {
      clock += ms;
      if (up && status === "running") {
        if (options.heartbeats !== false && clock - lastBeat >= HEARTBEAT_MS) {
          leaseUntil = iso(clock + leaseMs);
          lastBeat = clock;
        }
        if (restarted) {
          resumedMs += ms;
          if (resumedMs >= RESUMED_STREAM_MS) {
            status = options.finalStatus ?? "done";
          }
        }
      }
      return Promise.resolve();
    },
    startServer: () => {
      calls.push("start");
      up = true;
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

describe("runOutage", () => {
  test("passes when the run rides out the outage and finishes after the restart", async () => {
    const { calls, deps, out } = fakeOutage();
    await runOutage(deps);
    expect(out.map((line) => line.slice(0, 4))).toEqual([
      "ok 1",
      "ok 2",
      "ok 3",
      "ok 4",
      "ok 5",
    ]);
    expect(calls).toEqual([
      "offer run-1",
      "kill",
      "reap",
      "reap",
      "reap",
      "reap",
      "reap",
      "reap",
      "start",
    ]);
  });

  test("fails when the lease reaper interrupts the run during the outage", async () => {
    const { deps } = fakeOutage({ leaseMs: 90_000 });
    expect(await failureOf(runOutage(deps))).toContain(
      "the lease reaper interrupted run run-1"
    );
  });

  test("fails when the run does not end done", async () => {
    const { deps } = fakeOutage({ finalStatus: "failed" });
    expect(await failureOf(runOutage(deps))).toContain(
      "run-1 is failed, expected done"
    );
  });

  test("fails when the tool call after the restart returns an error", async () => {
    const { deps } = fakeOutage({ toolOk: false });
    expect(await failureOf(runOutage(deps))).toContain("the tool call failed");
  });

  test("fails when the lease never moves past its value before the outage", async () => {
    const { deps } = fakeOutage({ heartbeats: false });
    expect(await failureOf(runOutage(deps))).toContain(
      "the lease did not move past"
    );
  });
});
