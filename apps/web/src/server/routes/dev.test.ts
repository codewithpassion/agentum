import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { driveCloudRun, offerRunToRelay, runAtomicProbe } from "./dev.ts";

test("the atomic probe leaves no row behind when its second statement fails", async () => {
  const db = migrated();

  const result = await runAtomicProbe(db, sqliteAtomic(db));

  expect(result).toEqual({ failed: true, firstRowPresent: false });
});

test("an offer is forwarded to the relay of the machine", async () => {
  const offers: unknown[] = [];
  const relay = {
    ...noopRelay,
    offer: (machineId: string, run: { agentId: string; runId: string }) => {
      offers.push({ machineId, ...run });
      return Promise.resolve();
    },
  };

  const result = await offerRunToRelay(relay, {
    agentId: "agt_1",
    machineId: "mch_1",
    runId: "run_1",
  });

  expect(result).toEqual({ ok: true });
  expect(offers).toEqual([
    { agentId: "agt_1", machineId: "mch_1", runId: "run_1" },
  ]);
});

test("an offer with a missing field is refused and reaches no relay", async () => {
  const offers: unknown[] = [];
  const relay = {
    ...noopRelay,
    offer: () => {
      offers.push(1);
      return Promise.resolve();
    },
  };

  expect(await offerRunToRelay(relay, { runId: "run_1" })).toEqual({
    ok: false,
  });
  expect(offers).toEqual([]);
});

const fakeRuns = () => {
  const calls: string[] = [];
  const record = (name: string) => (_principal: unknown, runId: string) => {
    calls.push(`${name} ${runId}`);
    return Promise.resolve();
  };
  return {
    calls,
    runs: {
      cancelRun: record("cancel"),
      offerQueuedRun: record("offer"),
      releaseRun: record("release"),
    },
  };
};

test("a cloud run is offered, redispatched and cancelled by hand", async () => {
  const { calls, runs } = fakeRuns();

  await driveCloudRun(runs, "offer", { runId: "run_1" });
  await driveCloudRun(runs, "redispatch", { runId: "run_2" });
  await driveCloudRun(runs, "cancel", { runId: "run_3" });

  expect(calls).toEqual([
    "offer run_1",
    "release run_2",
    "offer run_2",
    "cancel run_3",
  ]);
});

test("a cloud action that is unknown, or has no run id, does nothing", async () => {
  const { calls, runs } = fakeRuns();

  expect(await driveCloudRun(runs, "delete", { runId: "run_1" })).toEqual({
    ok: false,
  });
  expect(await driveCloudRun(runs, "offer", {})).toEqual({ ok: false });
  expect(calls).toEqual([]);
});
