import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { offerRunToRelay, runAtomicProbe } from "./dev.ts";

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
