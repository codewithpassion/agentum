import { expect, test } from "bun:test";
import type { ClaimResponse } from "@repo/protocol/machine";
import type { RunExecution } from "./executor.ts";
import type { Logger } from "./log.ts";
import { createRunManager } from "./run-manager.ts";

interface FakeRun {
  aborts: string[];
  finish: () => void;
  runId: string;
}

const harness = (options: { claimFails?: Set<string> } = {}) => {
  const started: FakeRun[] = [];
  const claimed: string[] = [];
  const lines: string[] = [];
  const log: Logger = {
    error: (message) => lines.push(message),
    info: (message) => lines.push(message),
  };
  const manager = createRunManager({
    claim: (runId) => {
      claimed.push(runId);
      if (options.claimFails?.has(runId)) {
        return Promise.reject(new Error("Run cannot be claimed"));
      }
      return Promise.resolve({
        run: { id: runId },
      } as unknown as ClaimResponse);
    },
    execute: (claim) => {
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run: FakeRun = { aborts: [], finish, runId: claim.run.id };
      started.push(run);
      const execution: RunExecution = {
        abort: (reason) => run.aborts.push(reason),
        finished,
      };
      return execution;
    },
    log,
  });
  return { claimed, lines, manager, started };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a second offer for the same agent waits until the first run has finished", async () => {
  const { claimed, manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a1", runId: "r2" });
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r1"]);
  expect(claimed).toEqual(["r1"]);
  started[0]?.finish();
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r1", "r2"]);
});

test("offers for different agents run side by side", async () => {
  const { manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a2", runId: "r2" });
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r1", "r2"]);
});

test("a repeated offer for a known run is ignored", async () => {
  const { claimed, manager } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a1", runId: "r1" });
  await flush();
  expect(claimed).toEqual(["r1"]);
});

test("a failed claim is logged and the next offer goes ahead", async () => {
  const { lines, manager, started } = harness({ claimFails: new Set(["r1"]) });
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a1", runId: "r2" });
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r2"]);
  expect(lines.some((line) => line.includes("could not claim run r1"))).toBe(
    true
  );
});

test("cancel aborts the running run and drops a queued one", async () => {
  const { manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a1", runId: "r2" });
  await flush();
  manager.cancel("r2");
  manager.cancel("r1");
  expect(started[0]?.aborts).toEqual(["cancelled by the relay"]);
  started[0]?.finish();
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r1"]);
});

test("abortAll aborts every running run and forgets the queue", async () => {
  const { manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  manager.offer({ agentId: "a1", runId: "r2" });
  manager.offer({ agentId: "a2", runId: "r3" });
  await flush();
  manager.abortAll("replaced");
  expect(started.map((run) => run.aborts)).toEqual([
    ["replaced"],
    ["replaced"],
  ]);
  for (const run of started) {
    run.finish();
  }
  await flush();
  expect(started.map((run) => run.runId)).toEqual(["r1", "r3"]);
});

test("after stop no offer starts a run", async () => {
  const { claimed, manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  await flush();
  manager.stop("daemon stopping");
  expect(started[0]?.aborts).toEqual(["daemon stopping"]);
  manager.offer({ agentId: "a2", runId: "r2" });
  started[0]?.finish();
  await manager.idle();
  expect(claimed).toEqual(["r1"]);
});

test("idle waits for the slots to be released", async () => {
  const { manager, started } = harness();
  manager.offer({ agentId: "a1", runId: "r1" });
  await flush();
  let idle = false;
  const waiting = manager.idle().then(() => {
    idle = true;
  });
  await flush();
  expect(idle).toBe(false);
  started[0]?.finish();
  await waiting;
  expect(idle).toBe(true);
});
