import { beforeEach, describe, expect, test } from "bun:test";
import { a2aOutboundTasks, a2aTasks } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import {
  seedAssignment,
  seedConnector,
  seedCredential,
} from "../connectors/test-seed.ts";
import { createCredentialsService } from "../credentials.ts";
import { importSecretsKey } from "../crypto.ts";
import { MANAGED_REFUSAL, MANAGED_RUN_REFUSAL } from "./errors.ts";
import {
  createOutboundFixture,
  OUTBOUND_CONNECTION,
  type OutboundFixture,
  PEER_ORIGIN,
} from "./outbound-fixture.ts";
import {
  AGENT,
  member,
  peerOf,
  SECRETS_KEY,
  START,
  textMessage,
  WORKSPACE,
} from "./tasks-fixture.ts";

let f: OutboundFixture;

beforeEach(async () => {
  f = await createOutboundFixture();
});

type Call = Awaited<ReturnType<OutboundFixture["callingRun"]>>;

const runOf = async (id: string) => {
  const [row] = await f.db.select().from(runRows).where(eq(runRows.id, id));
  if (!row) {
    throw new Error(`No run ${id}`);
  }
  return row;
};

const wakeRun = async () =>
  (await f.db.select().from(runRows)).find((run) =>
    run.requestId?.startsWith("a2a-wake:")
  );

/** A run started by a trigger of the agent, claimed and ready to call. */
const triggerRun = async (): Promise<Call> => {
  const started = await f.runs.startRun(
    {
      agentId: AGENT,
      kind: "trigger",
      triggerId: "trg_1",
      workspaceId: WORKSPACE,
    },
    {
      agentId: AGENT,
      input: { text: "Ask the peer" },
      session: { origin: "trigger" },
    }
  );
  await f.runs.claimRun(f.system, started.runId);
  return {
    principal: {
      agentId: AGENT,
      kind: "run",
      runId: started.runId,
      workspaceId: WORKSPACE,
    },
    runId: started.runId,
    sessionId: started.sessionId,
  };
};

/** A run an inbound peer's task started, claimed and ready to call. */
const peerRun = async (): Promise<Call> => {
  await f.connect({ inboundPolicy: "auto" });
  const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
  const [row] = (await f.db.select().from(a2aTasks)).filter(
    (t) => t.id === task.id
  );
  if (!row?.runId) {
    throw new Error("The peer's task started no run");
  }
  await f.runs.claimRun(f.system, row.runId);
  return {
    principal: {
      agentId: AGENT,
      kind: "run",
      runId: row.runId,
      workspaceId: WORKSPACE,
    },
    runId: row.runId,
    sessionId: (await runOf(row.runId)).sessionId,
  };
};

/**
 * The wake a peer's answer starts: the calling run sends and ends, the answer
 * arrives after it, and the tick runs. Returns the wake run, if one started.
 */
const wakeFlow = async (call: Call) => {
  await f.outbound.send(call.principal, {
    connection: OUTBOUND_CONNECTION,
    requestId: "r1",
    text: "hello",
  });
  await f.runs.completeRun(f.system, call.runId, {
    status: "done",
    text: "asked",
  });
  f.peer.finish("rt-1", "Sunny and 21 degrees");
  f.advance(120_000);
  await f.outbound.pollDue(f.system);
  return await wakeRun();
};

describe("a wake's subject", () => {
  /** The calling run as stored, and the wake the peer's answer starts from it. */
  const callerAndWake = async (call: Call) => {
    const caller = await runOf(call.runId);
    const wake = await wakeFlow(call);
    if (!wake) {
      throw new Error("No wake run started");
    }
    return { caller, wake };
  };

  test("a wake of a member's run is the peer's, with no person and under that run", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const { caller, wake } = await callerAndWake(call);

    expect(caller.actorKind).toBe("user");
    expect(wake.actorKind).toBe("peer");
    expect(wake.actorId).toBe(OUTBOUND_CONNECTION);
    expect(wake.onBehalfOfUserId).toBeNull();
    expect(wake.parentRunId).toBe(call.runId);
    expect(wake.depth).toBe(caller.depth + 1);
  });

  test("a wake of a trigger's run is the peer's, with no person and under that run", async () => {
    await f.connectPeer();
    const call = await triggerRun();

    const { caller, wake } = await callerAndWake(call);

    expect(caller.actorKind).toBe("trigger");
    expect(wake.actorKind).toBe("peer");
    expect(wake.actorId).toBe(OUTBOUND_CONNECTION);
    expect(wake.onBehalfOfUserId).toBeNull();
    expect(wake.parentRunId).toBe(call.runId);
    expect(wake.depth).toBe(caller.depth + 1);
  });

  test("a wake of a peer's run is the outbound peer's, with no person and under that run", async () => {
    await f.connectPeer();
    const call = await peerRun();

    const { caller, wake } = await callerAndWake(call);

    expect(caller.actorKind).toBe("peer");
    expect(wake.actorKind).toBe("peer");
    expect(wake.actorId).toBe(OUTBOUND_CONNECTION);
    expect(wake.onBehalfOfUserId).toBeNull();
    expect(wake.parentRunId).toBe(call.runId);
    expect(wake.depth).toBe(caller.depth + 1);
  });

  test("a wake has no person's delegation, so a user-mode connector finds no credential for it", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const wake = await wakeFlow(call);
    if (!wake) {
      throw new Error("No wake run started");
    }
    await seedConnector(f.db, {
      authKind: "header",
      headerName: "X-Api-Key",
      id: "con_mcp",
      now: START,
      workspaceId: WORKSPACE,
    });
    await seedAssignment(f.db, {
      agentId: AGENT,
      connectorId: "con_mcp",
      credentialMode: "user",
      now: START,
      workspaceId: WORKSPACE,
    });
    await seedCredential(f.db, await importSecretsKey(SECRETS_KEY), {
      connectorId: "con_mcp",
      now: START,
      ownerId: "u-member",
      ownerKind: "user",
      secret: "member-key",
      workspaceId: WORKSPACE,
    });
    const credentials = createCredentialsService({
      clock: f.clock,
      db: f.db,
      fetch: () => Promise.reject(new Error("No token fetch expected")),
      secretsKey: SECRETS_KEY,
    });
    const resolveFor = (onBehalfOfUserId: string | null) =>
      credentials.resolve({
        agentId: AGENT,
        connectorId: "con_mcp",
        onBehalfOfUserId,
        workspaceId: WORKSPACE,
      });

    // The same seam finds the member's credential for the calling run.
    expect(
      await resolveFor((await runOf(call.runId)).onBehalfOfUserId)
    ).toMatchObject({
      credential: { header: { value: "member-key" } },
      ok: true,
    });
    expect(await resolveFor(wake.onBehalfOfUserId)).toMatchObject({
      cause: "no_person",
      ok: false,
      reason: "needs_auth",
    });
  });
});

describe("a wake on an agent moved to managed", () => {
  test("an answer that arrives after the run ended starts no wake, keeps its answer for the system, refuses a run of that agent, and is logged as not woken", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await f.outbound.send(call.principal, {
      connection: OUTBOUND_CONNECTION,
      requestId: "r1",
      text: "hello",
    });
    await f.runs.completeRun(f.system, call.runId, {
      status: "done",
      text: "asked",
    });
    await f.db
      .update(agents)
      .set({ runtime: "managed" })
      .where(eq(agents.id, AGENT));
    f.peer.finish("rt-1", "Sunny");
    f.advance(120_000);

    await f.outbound.pollDue(f.system);

    expect(await wakeRun()).toBeUndefined();
    // The system can still read it. A run of that agent can't: its tools can't be held.
    const read = await f.outbound.get(f.system, info.runId);
    expect(read.answer).not.toBeNull();
    await expect(f.outbound.get(call.principal, info.runId)).rejects.toThrow(
      MANAGED_RUN_REFUSAL
    );
    const logged = (await f.db.select().from(eventRows))
      .filter((event) => event.type === "a2a.result_received")
      .map((event) => JSON.parse(event.payload ?? "{}") as unknown);
    expect(logged).toContainEqual(
      expect.objectContaining({ outboundTaskId: info.runId, woke: false })
    );
  });

  test("a run of an agent moved to managed cannot send, and no outbound task is written", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    await f.db
      .update(agents)
      .set({ runtime: "managed" })
      .where(eq(agents.id, AGENT));

    await expect(
      f.outbound.send(call.principal, {
        connection: OUTBOUND_CONNECTION,
        requestId: "r1",
        text: "hello",
      })
    ).rejects.toThrow(MANAGED_RUN_REFUSAL);

    expect(await f.db.select().from(a2aOutboundTasks)).toHaveLength(0);
    expect(f.peer.calls).toHaveLength(0);
  });

  test("an agent on the managed runtime cannot take a new outbound connection", async () => {
    await f.db
      .update(agents)
      .set({ runtime: "managed" })
      .where(eq(agents.id, AGENT));

    await expect(
      f.connections.addOutbound(member("u-owner"), {
        agentId: AGENT,
        cardUrl: `${PEER_ORIGIN}/.well-known/agent-card.json`,
        label: "Fake Peer",
      })
    ).rejects.toThrow(MANAGED_REFUSAL);
  });
});
