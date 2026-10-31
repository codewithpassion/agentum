import { beforeEach, describe, expect, test } from "bun:test";
import {
  a2aAgentCards,
  a2aAnswerMarkers,
  a2aConnections,
  a2aOutbox,
  a2aTasks,
} from "@repo/db/schema/a2a";
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
    expect((error as Error).message).toContain(
      "started with a message from a peer"
    );
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

describe("two callers on one task", () => {
  const withPush = async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    await f.tasks.createPushConfig(peerOf(), {
      config: { url: "https://hook.example.com/x" },
      taskId: task.id,
    });
    return task;
  };
  const pushStates = async () =>
    (await f.db.select().from(a2aOutbox))
      .filter((row) => row.kind === "push")
      .map((row) => JSON.parse(row.body).task.status.state as string);

  test("a double approve starts one run and queues one push", async () => {
    const task = await withPush();
    const results = await Promise.allSettled([
      f.tasks.approveTask(member(), task.id),
      f.tasks.approveTask(member("u-other"), task.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await f.db.select().from(runRows)).toHaveLength(1);
    expect(await pushStates()).toEqual(["TASK_STATE_SUBMITTED"]);
  });

  test("an approve against a decline has one winner, and only its push is queued", async () => {
    const task = await withPush();
    await Promise.allSettled([
      f.tasks.approveTask(member(), task.id),
      f.tasks.declineTask(member("u-other"), task.id),
    ]);
    const final = (await taskRow(task.id))?.state;
    expect(["TASK_STATE_SUBMITTED", "TASK_STATE_REJECTED"]).toContain(
      final ?? ""
    );
    expect(await pushStates()).toEqual([final ?? ""]);
    const runs = await f.db.select().from(runRows);
    expect(runs).toHaveLength(final === "TASK_STATE_SUBMITTED" ? 1 : 0);
  });

  test("a loser queues no push", async () => {
    const task = await withPush();
    await f.tasks.declineTask(member(), task.id);
    await rejects(f.tasks.approveTask(member(), task.id));
    expect(await pushStates()).toEqual(["TASK_STATE_REJECTED"]);
  });
});

describe("a retried answer", () => {
  test("is not taken for the answer to the next question", async () => {
    const { runId, taskId } = await startAuto();
    await ask(runId, "First?", "q1");
    f.advance(1000);
    await ask(runId, "Second?", "q2");
    const answer = textMessage("m2", "Yes", { taskId });
    await f.tasks.sendMessage(peerOf(), answer);
    const again = await f.tasks.sendMessage(peerOf(), answer);
    expect(again.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(statusOf(again)).toContain("Second?");
    const answered = (await f.db.select().from(runRequests)).filter(
      (row) => row.status === "answered"
    );
    expect(answered).toHaveLength(1);
  });
});

describe("a connection that ended before the tasks on it were dealt with", () => {
  test("the sweep rejects the message that waits and cancels the run in flight", async () => {
    const { taskId } = await startAuto();
    await f.db
      .update(a2aConnections)
      .set({ inboundPolicy: "approve" })
      .where(eq(a2aConnections.id, CONNECTION));
    const waiting = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "Hi")
    );
    // Revoked with the hook never run.
    await f.db
      .update(a2aConnections)
      .set({ status: "revoked" })
      .where(eq(a2aConnections.id, CONNECTION));
    expect(await f.tasks.sweep(f.system)).toBeGreaterThan(0);
    expect((await taskRow(taskId))?.state).toBe("TASK_STATE_CANCELED");
    expect((await taskRow(waiting.id))?.state).toBe("TASK_STATE_REJECTED");
    expect(await runStatus(taskId)).toBe("cancelled");
    expect(await f.tasks.sweep(f.system)).toBe(0);
  });
});

describe("the sweep and the first of several questions", () => {
  test("the status moves on to the question still open", async () => {
    const { runId, taskId } = await startAuto();
    const first = await ask(runId, "First?", "q1");
    f.advance(1000);
    await ask(runId, "Second?", "q2");
    await f.db
      .update(runRequests)
      .set({ status: "cancelled" })
      .where(eq(runRequests.id, first.id));
    expect(await f.tasks.sweep(f.system)).toBe(1);
    const task = await f.tasks.getTask(peerOf(), { id: taskId });
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(statusOf(task)).toContain("Second?");
  });
});

describe("a run that fails to reach its runtime", () => {
  test("the task fails and the run that was written is cancelled", async () => {
    await f.connect({ inboundPolicy: "auto" });
    f.hooks.dispatchFails = true;
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(await runStatus(task.id)).toBe("cancelled");
  });
});

describe("a cancel in the gap before the run exists", () => {
  test("the run that gets made is cancelled", async () => {
    await f.connect({ inboundPolicy: "auto" });
    f.hooks.beforeStartRun = async () => {
      const [row] = await f.db.select().from(a2aTasks);
      await f.tasks.cancelTask(peerOf(), { id: row?.id ?? "" });
    };
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    expect(task.status.state).toBe("TASK_STATE_CANCELED");
    expect(await runStatus(task.id)).toBe("cancelled");
  });
});

describe("a peer starting a run on a managed agent", () => {
  test("is refused by the runs service itself", async () => {
    await f.seedAgent("a-managed", "managed");
    const error = await rejects(
      f.runs.startRun(
        { ...peerOf(), agentId: "a-managed" },
        {
          agentId: "a-managed",
          input: { text: "Go" },
          session: { origin: "a2a" },
        }
      )
    );
    expect((error as Error).message).toContain(
      "started with a message from a peer"
    );
  });
});

describe("two requests racing on one task, each with a service of its own", () => {
  const racers = async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    await f.tasks.createPushConfig(peerOf(), {
      config: { url: "https://hook.example.com/x" },
      taskId: task.id,
    });
    return task;
  };

  test("a double approve starts exactly one run and queues one push", async () => {
    const task = await racers();
    const other = f.newTasks();
    const results = await Promise.allSettled([
      f.tasks.approveTask(member(), task.id),
      other.approveTask(member("u-other"), task.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await f.db.select().from(runRows)).toHaveLength(1);
    const pushes = (await f.db.select().from(a2aOutbox)).filter(
      (row) => row.kind === "push"
    );
    expect(pushes).toHaveLength(1);
  });

  test("an approve against a decline has one winner", async () => {
    const task = await racers();
    const other = f.newTasks();
    const results = await Promise.allSettled([
      f.tasks.approveTask(member(), task.id),
      other.declineTask(member("u-other"), task.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = (await taskRow(task.id))?.state;
    expect((await f.db.select().from(runRows)).length).toBe(
      final === "TASK_STATE_SUBMITTED" ? 1 : 0
    );
  });
});

describe("the sweep with a full batch of tasks that are fine", () => {
  test("a stuck task behind them is still reached", async () => {
    await f.connect({ hourlyLimit: 1000, inboundPolicy: "auto" });
    const healthy = 56;
    for (let index = 0; index < healthy; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each task is made after the one before, so their ages differ
      const task = await f.tasks.sendMessage(
        peerOf(),
        textMessage(`h${index}`, "Go")
      );
      const runId = (await taskRow(task.id))?.runId ?? "";
      // A cloud agent runs one run at a time, so the others are set running by hand.
      await f.db
        .update(runRows)
        .set({ status: "running" })
        .where(eq(runRows.id, runId));
      await ask(runId, `Question ${index}?`, `q${index}`);
      f.advance(1000);
    }
    const stuck = await f.tasks.sendMessage(peerOf(), textMessage("s", "Go"));
    const stuckRunId = (await taskRow(stuck.id))?.runId ?? "";
    // Its run failed and no event was heard.
    await f.db
      .update(runRows)
      .set({ status: "failed" })
      .where(eq(runRows.id, stuckRunId));
    expect(await f.tasks.sweep(f.system)).toBe(0);
    expect((await taskRow(stuck.id))?.state).toBe("TASK_STATE_SUBMITTED");
    // The next minutes: the batch rotates, so the stuck task is reached soon.
    const minute = async () => {
      f.advance(60_000);
      await f.tasks.sweep(f.system);
    };
    await minute();
    await minute();
    await minute();
    expect((await taskRow(stuck.id))?.state).toBe("TASK_STATE_FAILED");
  });
});

describe("the marker of an answer", () => {
  const twoQuestions = async () => {
    const { runId, taskId } = await startAuto();
    const first = await ask(runId, "First?", "q1");
    f.advance(1000);
    await ask(runId, "Second?", "q2");
    return { first, taskId };
  };
  const markAnswer = (taskId: string, requestId: string, messageId: string) =>
    f.db.insert(a2aAnswerMarkers).values({
      connectionId: CONNECTION,
      createdAt: "2026-11-01T10:00:00.000Z",
      id: `ans_${messageId}`,
      messageId,
      requestId,
      taskId,
      workspaceId: WORKSPACE,
    });
  const answeredCount = async () =>
    (await f.db.select().from(runRequests)).filter(
      (row) => row.status === "answered"
    ).length;

  test("a retry finds the marker, answers nothing and returns the task as it is", async () => {
    const { taskId } = await twoQuestions();
    const answer = textMessage("m2", "Yes", { taskId });
    await f.tasks.sendMessage(peerOf(), answer);
    const again = await f.tasks.sendMessage(peerOf(), answer);
    expect(again.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(await answeredCount()).toBe(1);
    const markers = await f.db.select().from(a2aAnswerMarkers);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.taskId).toBe(taskId);
  });

  test("a request that died after the marker answers nothing, and a new message id answers the open question", async () => {
    const { first, taskId } = await twoQuestions();
    // The marker went in and the request died before the answer.
    await markAnswer(taskId, first.id, "m2");
    const retry = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "Yes", { taskId })
    );
    expect(retry.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(statusOf(retry)).toContain("First?");
    expect(await answeredCount()).toBe(0);
    const next = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m3", "Yes", { taskId })
    );
    expect(statusOf(next)).toContain("Second?");
    expect(await answeredCount()).toBe(1);
    const stored = (await f.db.select().from(runRequests)).find(
      (row) => row.id === first.id
    );
    expect(stored?.status).toBe("answered");
  });

  test("a message id used on another task is refused", async () => {
    const { first, taskId } = await twoQuestions();
    await markAnswer(taskId, first.id, "m2");
    const other = await f.tasks.sendMessage(peerOf(), textMessage("o1", "Hi"));
    const error = await rejects(
      f.tasks.sendMessage(
        peerOf(),
        textMessage("m2", "Yes", { taskId: other.id })
      )
    );
    expect((error as Error).message).toContain("already used");
  });
});
