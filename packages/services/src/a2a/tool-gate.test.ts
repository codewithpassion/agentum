import { beforeEach, describe, expect, test } from "bun:test";
import { a2aConnections, a2aTasks } from "@repo/db/schema/a2a";
import { events as eventRows } from "@repo/db/schema/events";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import {
  AGENT,
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  OTHER_CONNECTION,
  peerOf,
  textMessage,
} from "./tasks-fixture.ts";

let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
});

const rejects = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused");
};

const serviceCode = (error: unknown) =>
  error instanceof ServiceError ? error.code : undefined;

const runIdOf = async (taskId: string): Promise<string> => {
  const [task] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  if (!task?.runId) {
    throw new Error(`Task ${taskId} has no run`);
  }
  return task.runId;
};

/** A peer's task, its run claimed and running. */
const peerRun = async (): Promise<string> => {
  const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
  const runId = await runIdOf(task.id);
  await f.runs.claimRun(f.system, runId);
  return runId;
};

const needs = (runId: string, toolKey: string) =>
  f.requests.needsApproval(f.system, { runId, toolKey });

const QUESTION = {
  kind: "question" as const,
  questions: [{ question: "Which one?" }],
  toolName: "AskUserQuestion",
  toolUseId: "q1",
};

/** A peer's run with a question open on it. */
const peerQuestion = async () => {
  await f.connect({ inboundPolicy: "auto" });
  const runId = await peerRun();
  const request = await f.requests.open(f.system, { ...QUESTION, runId });
  return { requestId: request.id, runId };
};

describe("tool gate for a peer's run", () => {
  test("at ask every tool needs approval, rules or not", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const runId = await peerRun();
    const keys = [
      "bash",
      "read",
      "harbourmaster/send_message",
      "harbourmaster/library_read",
      "xero/list_invoices",
      "web_fetch",
      "anything/at_all",
    ];
    const answers = await Promise.all(
      keys.map((toolKey) => needs(runId, toolKey))
    );
    expect(answers).toEqual(keys.map(() => true));
  });

  test("at agent_rules the agent's own rules decide", async () => {
    await f.connect({ inboundPolicy: "auto", toolPolicy: "agent_rules" });
    const runId = await peerRun();
    expect(await needs(runId, "bash")).toBe(false);

    await f.requests.setRule(member(), {
      agentId: AGENT,
      mode: "ask",
      toolKey: "bash",
    });
    expect(await needs(runId, "bash")).toBe(true);
    expect(await needs(runId, "read")).toBe(false);

    await f.requests.setRule(member(), {
      agentId: AGENT,
      mode: "allow",
      toolKey: "bash",
    });
    expect(await needs(runId, "bash")).toBe(false);
  });

  test("a person's run on the same agent is not gated by a connection at ask", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const started = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "go" },
      session: { origin: "ui" },
    });
    await f.runs.claimRun(f.system, started.runId);
    expect(await needs(started.runId, "bash")).toBe(false);
  });

  test("flipping the connection's policy changes the answer on a run already in progress", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const runId = await peerRun();
    expect(await needs(runId, "read")).toBe(true);

    await f.db
      .update(a2aConnections)
      .set({ toolPolicy: "agent_rules" })
      .where(eq(a2aConnections.id, CONNECTION));
    expect(await needs(runId, "read")).toBe(false);

    await f.db
      .update(a2aConnections)
      .set({ toolPolicy: "ask" })
      .where(eq(a2aConnections.id, CONNECTION));
    expect(await needs(runId, "read")).toBe(true);
  });

  test("a peer run whose connection row is gone needs approval (fails closed)", async () => {
    await f.connect({ inboundPolicy: "auto", toolPolicy: "agent_rules" });
    const runId = await peerRun();
    expect(await needs(runId, "read")).toBe(false);

    await f.db
      .update(runRows)
      .set({ actorId: "con_gone" })
      .where(eq(runRows.id, runId));
    expect(await needs(runId, "read")).toBe(true);
  });

  test("answerAsPeer refuses a principal that is not a peer", async () => {
    const { requestId } = await peerQuestion();
    const error = await rejects(
      f.requests.answerAsPeer(member(), { requestId, text: "Blue" })
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  test("answerAsPeer refuses a peer of another connection", async () => {
    const { requestId } = await peerQuestion();
    await f.connect({ id: OTHER_CONNECTION });
    const error = await rejects(
      f.requests.answerAsPeer(peerOf(OTHER_CONNECTION), {
        requestId,
        text: "Blue",
      })
    );
    expect(serviceCode(error)).toBe("not_found");
  });

  test("answerAsPeer cannot answer an approval, which stays pending", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const runId = await peerRun();
    const approval = await f.requests.open(f.system, {
      input: { command: "ls" },
      kind: "approval",
      runId,
      toolKey: "bash",
      toolName: "bash",
      toolUseId: "t1",
    });
    const error = await rejects(
      f.requests.answerAsPeer(peerOf(), { requestId: approval.id, text: "yes" })
    );
    expect(serviceCode(error)).toBe("not_found");
    const [row] = await f.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, approval.id));
    expect(row?.status).toBe("pending");
  });

  test("answering a question twice is a conflict", async () => {
    const { requestId } = await peerQuestion();
    await f.requests.answerAsPeer(peerOf(), { requestId, text: "Blue" });
    const error = await rejects(
      f.requests.answerAsPeer(peerOf(), { requestId, text: "Red" })
    );
    expect(serviceCode(error)).toBe("conflict");
  });

  test("an answer of only spaces is refused by schema validation", async () => {
    const { requestId } = await peerQuestion();
    const error = await rejects(
      f.requests.answerAsPeer(peerOf(), { requestId, text: "   " })
    );
    expect(error).toBeInstanceOf(ZodError);
    const [row] = await f.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, requestId));
    expect(row?.status).toBe("pending");
  });

  test("a peer's answer is stored with the connection as the answerer and an event by the peer", async () => {
    const { requestId } = await peerQuestion();
    await f.requests.answerAsPeer(peerOf(), { requestId, text: "Blue" });

    const [row] = await f.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, requestId));
    expect(row?.status).toBe("answered");
    expect(row?.answeredBy).toBe(CONNECTION);
    expect(row?.answeredVia).toBe("a2a");

    const answered = await f.db
      .select({
        actorId: eventRows.actorId,
        actorKind: eventRows.actorKind,
      })
      .from(eventRows)
      .where(eq(eventRows.type, "request.answered"));
    expect(answered).toEqual([{ actorId: CONNECTION, actorKind: "peer" }]);
  });

  test("a peer cannot answer a question on a run that belongs to a person", async () => {
    const started = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "go" },
      session: { origin: "ui" },
    });
    await f.runs.claimRun(f.system, started.runId);
    const request = await f.requests.open(f.system, {
      ...QUESTION,
      runId: started.runId,
    });
    await f.connect({ inboundPolicy: "auto" });
    const error = await rejects(
      f.requests.answerAsPeer(peerOf(), { requestId: request.id, text: "Blue" })
    );
    expect(serviceCode(error)).toBe("not_found");
    const [row] = await f.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, request.id));
    expect(row?.status).toBe("pending");
  });
});

describe("approval display for a peer's run", () => {
  const APPROVAL = {
    input: { command: "ls" },
    kind: "approval" as const,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "t1",
  };

  const storedDisplay = async (requestId: string) => {
    const [row] = await f.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, requestId));
    return JSON.parse(row?.display ?? "{}") as Record<string, unknown>;
  };

  test("a peer's run marks its approval as peer-run, stored and announced", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const runId = await peerRun();
    const opened: Record<string, unknown>[] = [];
    f.events.onAppend((event) => {
      if (event.type === "request.opened") {
        opened.push(event.payload);
      }
      return Promise.resolve();
    });
    const approval = await f.requests.open(f.system, {
      ...APPROVAL,
      runId,
    });
    expect((await storedDisplay(approval.id)).peerRun).toBe(true);
    expect(opened).toEqual([
      expect.objectContaining({
        display: expect.objectContaining({ peerRun: true }),
      }),
    ]);
  });

  test("a member's run does not carry the peer-run key", async () => {
    const started = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "go" },
      session: { origin: "ui" },
    });
    await f.runs.claimRun(f.system, started.runId);
    const approval = await f.requests.open(f.system, {
      ...APPROVAL,
      runId: started.runId,
    });
    expect("peerRun" in (await storedDisplay(approval.id))).toBe(false);
  });

  test("a child run that a peer's run handed work to carries the peer-run key", async () => {
    await f.connect({ inboundPolicy: "auto" });
    // The child is claimed first: a queued peer run older than it would block the claim.
    const started = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "go" },
      session: { origin: "ui" },
    });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const parentRunId = await runIdOf(task.id);
    await f.db
      .update(runRows)
      .set({ parentRunId })
      .where(eq(runRows.id, started.runId));
    await f.runs.claimRun(f.system, started.runId);
    const approval = await f.requests.open(f.system, {
      ...APPROVAL,
      runId: started.runId,
    });
    expect((await storedDisplay(approval.id)).peerRun).toBe(true);
  });
});
