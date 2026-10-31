import { beforeEach, describe, expect, test } from "bun:test";
import { a2aAgentCards, a2aConnections, a2aTasks } from "@repo/db/schema/a2a";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import { A2aRateLimitError } from "./errors.ts";
import {
  AGENT,
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  peerOf,
  textMessage,
  WORKSPACE,
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

const taskRow = async (taskId: string) => {
  const [row] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  return row;
};

const runStatus = async (taskId: string) => {
  const row = await taskRow(taskId);
  const [run] = row?.runId
    ? await f.db.select().from(runRows).where(eq(runRows.id, row.runId))
    : [];
  return run?.status;
};

const startAuto = async () => {
  await f.connect({ inboundPolicy: "auto" });
  const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
  const row = await taskRow(task.id);
  await f.runs.claimRun(f.system, row?.runId ?? "");
  return { runId: row?.runId ?? "", taskId: task.id };
};

const ask = (runId: string, question: string, toolUseId: string) =>
  f.requests.open(f.system, {
    kind: "question",
    questions: [{ question }],
    runId,
    toolName: "AskUserQuestion",
    toolUseId,
  });

const statusOf = (task: {
  status: { message?: { parts: { text?: string }[] } };
}) => task.status.message?.parts[0]?.text ?? "";

describe("two questions open at once", () => {
  test("the answer goes to the question the status shows, and the next one follows", async () => {
    const { runId, taskId } = await startAuto();
    await ask(runId, "Delete the production data?", "q1");
    f.advance(1000);
    await ask(runId, "Delete the staging data?", "q2");
    const first = await f.tasks.getTask(peerOf(), { id: taskId });
    expect(statusOf(first)).toContain("production");
    const answered = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "No", { taskId })
    );
    expect(answered.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(statusOf(answered)).toContain("staging");
    const done = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m3", "Yes", { taskId })
    );
    expect(done.status.state).toBe("TASK_STATE_WORKING");
  });
});

describe("a revoke or cancel in the gap before the run exists", () => {
  test("the run that gets made is cancelled", async () => {
    await f.connect({ inboundPolicy: "auto" });
    f.hooks.beforeStartRun = async () => {
      await f.connections.revoke(member(), CONNECTION);
    };
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const row = await taskRow(task.id);
    expect(row?.state).toBe("TASK_STATE_CANCELED");
    expect(row?.runId).not.toBeNull();
    expect(await runStatus(task.id)).toBe("cancelled");
  });

  test("a task that ended with its run still alive has the run cancelled by the sweep", async () => {
    const { taskId } = await startAuto();
    await f.db
      .update(a2aTasks)
      .set({ state: "TASK_STATE_CANCELED" })
      .where(eq(a2aTasks.id, taskId));
    expect(await runStatus(taskId)).toBe("running");
    expect(await f.tasks.sweep(f.system)).toBe(1);
    expect(await runStatus(taskId)).toBe("cancelled");
    expect(await f.tasks.sweep(f.system)).toBe(0);
  });
});

describe("the sweep and questions", () => {
  test("a question that closed unheard returns the task to working", async () => {
    const { runId, taskId } = await startAuto();
    const request = await ask(runId, "Which one?", "q1");
    expect((await f.tasks.getTask(peerOf(), { id: taskId })).status.state).toBe(
      "TASK_STATE_INPUT_REQUIRED"
    );
    // Closed with no event heard.
    await f.db
      .update(runRequests)
      .set({ status: "cancelled" })
      .where(eq(runRequests.id, request.id));
    expect(await f.tasks.sweep(f.system)).toBe(1);
    expect((await f.tasks.getTask(peerOf(), { id: taskId })).status.state).toBe(
      "TASK_STATE_WORKING"
    );
  });

  test("a task that waits on a tool approval and is still submitted becomes working", async () => {
    const { runId, taskId } = await startAuto();
    await f.db
      .update(a2aTasks)
      .set({ state: "TASK_STATE_SUBMITTED" })
      .where(eq(a2aTasks.id, taskId));
    await f.requests.open(f.system, {
      input: { command: "ls" },
      kind: "approval",
      runId,
      toolKey: "bash",
      toolName: "bash",
      toolUseId: "t1",
    });
    expect(await f.tasks.sweep(f.system)).toBe(1);
    expect((await f.tasks.getTask(peerOf(), { id: taskId })).status.state).toBe(
      "TASK_STATE_WORKING"
    );
  });
});

describe("the hourly limit under concurrent sends", () => {
  test("only as many tasks are made as the limit allows", async () => {
    await f.connect({ hourlyLimit: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        f.tasks.sendMessage(peerOf(), textMessage(`m${index}`, "Hi"))
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        A2aRateLimitError
      );
    }
    expect(await f.db.select().from(a2aTasks)).toHaveLength(2);
  });
});

describe("a run that cannot start", () => {
  test("the peer reads a failed task, never the reason", async () => {
    await f.seedAgent("a-machine", "machine");
    await f.connect({ inboundPolicy: "auto", localAgentId: "a-machine" });
    const task = await f.tasks.sendMessage(
      { ...peerOf(), agentId: "a-machine" },
      textMessage("m1", "Go")
    );
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(statusOf(task)).toBe("The message could not be started.");
    expect(JSON.stringify(task)).not.toContain("runtime");
  });
});

describe("an agent that is no longer published", () => {
  test("a waiting message cannot be approved", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    await f.db
      .update(a2aAgentCards)
      .set({ unpublishedAt: "2026-11-01T10:30:00.000Z" })
      .where(eq(a2aAgentCards.agentId, AGENT));
    await rejects(f.tasks.approveTask(member(), task.id));
    expect((await taskRow(task.id))?.state).toBe("TASK_STATE_AUTH_REQUIRED");
  });
});

describe("work a peer's run hands on", () => {
  const handOff = async (toAgent: string) => {
    const { runId } = await startAuto();
    return await f.runs.startRun(
      { agentId: AGENT, kind: "run", runId, workspaceId: WORKSPACE },
      {
        agentId: toAgent,
        input: { text: "Please do this" },
        session: { origin: "mcp" },
      }
    );
  };

  test("the child run asks for every tool while the connection asks", async () => {
    await f.seedAgent("a-child");
    const child = await handOff("a-child");
    await f.runs.claimRun(f.system, child.runId);
    expect(
      await f.requests.needsApproval(f.system, {
        runId: child.runId,
        toolKey: "bash",
      })
    ).toBe(true);
    await f.db
      .update(a2aConnections)
      .set({ toolPolicy: "agent_rules" })
      .where(eq(a2aConnections.id, CONNECTION));
    expect(
      await f.requests.needsApproval(f.system, {
        runId: child.runId,
        toolKey: "bash",
      })
    ).toBe(false);
  });

  test("a managed agent cannot take it", async () => {
    await f.seedAgent("a-managed", "managed");
    const error = await rejects(handOff("a-managed"));
    expect((error as Error).message).toContain("managed");
  });

  test("a revoked connection asks for every tool whatever its policy was", async () => {
    const { runId } = await startAuto();
    await f.db
      .update(a2aConnections)
      .set({ status: "revoked", toolPolicy: "agent_rules" })
      .where(eq(a2aConnections.id, CONNECTION));
    expect(
      await f.requests.needsApproval(f.system, { runId, toolKey: "bash" })
    ).toBe(true);
  });
});

describe("with the fake runtime", () => {
  test("auto policy runs the message end to end", async () => {
    const fake = await createFixture({ fake: true });
    await fake.connect({ inboundPolicy: "auto" });
    const task = await fake.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello there")
    );
    const done = await fake.tasks.getTask(peerOf(), { id: task.id });
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.artifacts?.[0]?.parts[0]?.text).toContain("Echo:");
    expect(done.artifacts?.[0]?.parts[0]?.text).toContain("Hello there");
  });

  test("approve policy runs it after a person approves", async () => {
    const fake = await createFixture({ fake: true });
    await fake.connect();
    const task = await fake.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hi")
    );
    expect(task.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    await fake.tasks.approveTask(member(), task.id);
    expect(
      (await fake.tasks.getTask(peerOf(), { id: task.id })).status.state
    ).toBe("TASK_STATE_COMPLETED");
  });
});
