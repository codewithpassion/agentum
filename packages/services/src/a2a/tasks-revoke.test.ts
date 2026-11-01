import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { a2aTasks } from "@repo/db/schema/a2a";
import { runs as runRows } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import {
  createOutboundFixture,
  OUTBOUND_CONNECTION,
  type OutboundFixture,
} from "./outbound-fixture.ts";
import {
  AGENT,
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  OTHER_CONNECTION,
  peerOf,
  textMessage,
  WORKSPACE,
} from "./tasks-fixture.ts";

/** The batch size of `sweep` and of each revoke round, as set in `tasks.ts`. */
const SWEEP_BATCH = 50;

let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
});

afterEach(() => {
  mock.restore();
});

interface Run {
  agentId: string;
  id: string;
}

const statusOf = async (runId: string, db = f.db) =>
  (await db.select().from(runRows).where(eq(runRows.id, runId)))[0]?.status;

/**
 * Makes `runs.cancelRun` refuse for the runs `refuse` names. The tasks service
 * reaches `cancelRun` through `f.runs`, so the swap is seen by the revoke hook.
 * Returns the function that puts the real one back.
 */
const failCancels = (refuse: (runId: string) => boolean) => {
  const real = f.runs.cancelRun;
  f.runs.cancelRun = (principal, runId) =>
    refuse(runId)
      ? Promise.reject(new Error("cancel refused"))
      : real(principal, runId);
  return () => {
    f.runs.cancelRun = real;
  };
};

/** The run of a peer's task on CONNECTION, claimed so that it is running. */
const peerRun = async (): Promise<Run> => {
  await f.connect({ inboundPolicy: "auto" });
  const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
  const [row] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, task.id));
  if (!row?.runId) {
    throw new Error("the task has no run");
  }
  await f.runs.claimRun(f.system, row.runId);
  return { agentId: AGENT, id: row.runId };
};

/** A run that `from` starts for `agentId`, as a run principal does through `send_message`. */
const handOff = async (from: Run, agentId: string): Promise<Run> => {
  const started = await f.runs.startRun(
    {
      agentId: from.agentId,
      kind: "run",
      runId: from.id,
      workspaceId: WORKSPACE,
    },
    { agentId, input: { text: "handed" }, session: { origin: "ui" } }
  );
  return { agentId, id: started.runId };
};

describe("revoke cancels the runs a peer's connection set going", () => {
  test("a queued and a running hand-off are cancelled", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    await f.seedAgent("agt_c");
    const queued = await handOff(parent, "agt_b");
    const running = await handOff(parent, "agt_c");
    await f.runs.claimRun(f.system, running.id);

    await f.connections.revoke(member(), CONNECTION);

    expect(await statusOf(queued.id)).toBe("cancelled");
    expect(await statusOf(running.id)).toBe("cancelled");
  });

  test("a grandchild is cancelled too", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    await f.seedAgent("agt_c");
    const child = await handOff(parent, "agt_b");
    await f.runs.claimRun(f.system, child.id);
    const grandchild = await handOff(child, "agt_c");

    await f.connections.revoke(member(), CONNECTION);

    expect(await statusOf(grandchild.id)).toBe("cancelled");
  });

  test("a child of a parent that completed before the revoke is cancelled", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    const child = await handOff(parent, "agt_b");
    await f.runs.completeRun(f.system, parent.id, {
      status: "done",
      text: "asked",
    });

    await f.connections.revoke(member(), CONNECTION);

    expect(await statusOf(child.id)).toBe("cancelled");
  });

  test("a child of a parent that was cancelled before the revoke is cancelled", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    const child = await handOff(parent, "agt_b");
    await f.runs.cancelRun(f.system, parent.id);

    await f.connections.revoke(member(), CONNECTION);

    expect(await statusOf(child.id)).toBe("cancelled");
  });

  test("runs under another connection, or a member's own run on the same agent, are untouched", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    await f.seedAgent("agt_c");
    await f.connect({ id: OTHER_CONNECTION, inboundPolicy: "auto" });
    const other = await f.tasks.sendMessage(
      peerOf(OTHER_CONNECTION),
      textMessage("m2", "Go")
    );
    const [otherRow] = await f.db
      .select()
      .from(a2aTasks)
      .where(eq(a2aTasks.id, other.id));
    const otherRun: Run = { agentId: AGENT, id: otherRow?.runId ?? "" };
    const otherChild = await handOff(otherRun, "agt_c");
    const own = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "mine" },
      session: { origin: "ui" },
    });
    const before = [
      await statusOf(otherRun.id),
      await statusOf(otherChild.id),
      await statusOf(own.runId),
    ];

    await f.connections.revoke(member(), CONNECTION);

    expect(await statusOf(parent.id)).toBe("cancelled");
    expect([
      await statusOf(otherRun.id),
      await statusOf(otherChild.id),
      await statusOf(own.runId),
    ]).toEqual(before);
  });

  test("a wake whose calling run ended is cancelled", async () => {
    const o: OutboundFixture = await createOutboundFixture();
    await o.connectPeer();
    const call = await o.callingRun({});
    await o.outbound.send(call.principal, {
      connection: OUTBOUND_CONNECTION,
      requestId: "r1",
      text: "hello",
    });
    await o.runs.completeRun(o.system, call.runId, {
      status: "done",
      text: "asked",
    });
    o.peer.finish("rt-1", "the answer");
    o.advance(120_000);
    await o.outbound.pollDue(o.system);
    const wake = (await o.db.select().from(runRows)).find((r) =>
      r.requestId?.startsWith("a2a-wake:")
    );
    expect(wake).toBeDefined();
    expect(wake?.status).not.toBe("cancelled");

    await o.connections.revoke(member(), OUTBOUND_CONNECTION);

    expect(await statusOf(wake?.id ?? "", o.db)).toBe("cancelled");
  });

  test("a sweep after a revoke whose cancel failed cancels the live descendant", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    const child = await handOff(parent, "agt_b");
    const restore = failCancels((id) => id === child.id);
    spyOn(console, "error").mockImplementation(() => undefined);

    await f.connections.revoke(member(), CONNECTION);
    restore();
    expect(await statusOf(child.id)).toBe("queued");

    await f.tasks.sweep(f.system);

    expect(await statusOf(child.id)).toBe("cancelled");
  });

  test("a sweep with no ended connection around touches no run", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    const child = await handOff(parent, "agt_b");

    await f.tasks.sweep(f.system);

    expect(await statusOf(parent.id)).toBe("running");
    expect(await statusOf(child.id)).toBe("queued");
  });

  test("more children than one batch are all cancelled by the revoke rounds", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    const children: Run[] = [];
    for (let i = 0; i < SWEEP_BATCH + 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each start writes its run and events in order
      children.push(await handOff(parent, "agt_b"));
    }

    await f.connections.revoke(member(), CONNECTION);

    const statuses = await Promise.all(children.map((c) => statusOf(c.id)));
    expect(statuses.every((s) => s === "cancelled")).toBe(true);
  });

  test("when every cancel fails in the revoke, the sweep finishes a batch per call", async () => {
    const parent = await peerRun();
    await f.seedAgent("agt_b");
    for (let i = 0; i < SWEEP_BATCH + 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each start writes its run and events in order
      await handOff(parent, "agt_b");
    }
    // The children of the parent that a sweep has cancelled so far.
    const childrenCancelled = async () =>
      (await f.db.select().from(runRows)).filter(
        (r) => r.parentRunId === parent.id && r.status === "cancelled"
      ).length;
    const restore = failCancels(() => true);
    spyOn(console, "error").mockImplementation(() => undefined);

    await f.connections.revoke(member(), CONNECTION);
    restore();
    expect(await childrenCancelled()).toBe(0);

    await f.tasks.sweep(f.system);
    expect(await childrenCancelled()).toBe(SWEEP_BATCH);

    await f.tasks.sweep(f.system);
    expect(await childrenCancelled()).toBe(SWEEP_BATCH + 10);
  });
});
