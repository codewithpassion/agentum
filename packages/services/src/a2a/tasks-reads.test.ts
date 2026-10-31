import { beforeEach, describe, expect, test } from "bun:test";
import type { Task } from "@repo/a2a/tasks";
import { a2aTasks } from "@repo/db/schema/a2a";
import { runs as runRows } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import { ServiceError } from "../errors.ts";
import { A2aTaskError } from "./errors.ts";
import {
  createFixture,
  type Fixture,
  member,
  peerOf,
  START,
  textMessage,
} from "./tasks-fixture.ts";

const MINUTE_MS = 60_000;
const ERROR_WORDS = /error|exception/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

const runOf = async (taskId: string) => {
  const [task] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  const [run] = task?.runId
    ? await f.db.select().from(runRows).where(eq(runRows.id, task.runId))
    : [];
  return run;
};

const statusText = (task: Task) => task.status.message?.parts[0]?.text ?? "";

/** The ISO time `ms` after the fixture's start. */
const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

/**
 * What is wrong with a task's status message as a person reads it. Empty when
 * it is agent text, plain, and free of error words.
 */
const plainStatusProblems = (task: Task): string[] => {
  const text = statusText(task);
  const problems: string[] = [];
  if (task.status.message?.role !== "ROLE_AGENT") {
    problems.push("not from the agent");
  }
  if (text === "") {
    problems.push("empty text");
  }
  if (
    JSON.stringify(task.status.message?.parts) !== JSON.stringify([{ text }])
  ) {
    problems.push("not plain text");
  }
  if (ERROR_WORDS.test(text.toLowerCase())) {
    problems.push("mentions an error");
  }
  return problems;
};

describe("historyLength", () => {
  /** An unfinished task on the default approve policy: the peer's message, then the status message. */
  const waiting = async () => {
    await f.connect();
    return await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hello"));
  };

  test("unset keeps the peer's message and the agent's status message while the task is unfinished", async () => {
    const task = await waiting();
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.history?.map((message) => message.role)).toEqual([
      "ROLE_USER",
      "ROLE_AGENT",
    ]);
    expect(read.history?.[0]?.parts).toEqual([{ text: "Hello" }]);
    expect(read.history?.[1]?.parts).toEqual([{ text: statusText(task) }]);
  });

  test("0 returns no history member at all", async () => {
    const task = await waiting();
    const read = await f.tasks.getTask(peerOf(), {
      historyLength: 0,
      id: task.id,
    });
    expect(read).not.toHaveProperty("history");
  });

  test("1 returns only the last message", async () => {
    const task = await waiting();
    const read = await f.tasks.getTask(peerOf(), {
      historyLength: 1,
      id: task.id,
    });
    expect(read.history?.map((message) => message.role)).toEqual([
      "ROLE_AGENT",
    ]);
    expect(read.history?.[0]?.parts).toEqual([{ text: statusText(task) }]);
  });

  test("a number larger than the history returns all of it", async () => {
    const task = await waiting();
    const read = await f.tasks.getTask(peerOf(), {
      historyLength: 10,
      id: task.id,
    });
    expect(read.history?.map((message) => message.role)).toEqual([
      "ROLE_USER",
      "ROLE_AGENT",
    ]);
  });

  test("sendMessage takes configuration.historyLength", async () => {
    await f.connect();
    const last = await f.tasks.sendMessage(peerOf(), {
      ...textMessage("m1", "Hello"),
      configuration: { historyLength: 1 },
    });
    expect(last.history?.map((message) => message.role)).toEqual([
      "ROLE_AGENT",
    ]);
    const none = await f.tasks.sendMessage(peerOf(), {
      ...textMessage("m2", "Hello again"),
      configuration: { historyLength: 0 },
    });
    expect(none).not.toHaveProperty("history");
  });

  test("listTasks with no historyLength returns no history, and 1 returns the last message", async () => {
    await waiting();
    const unset = await f.tasks.listTasks(peerOf());
    expect(unset.tasks[0]).not.toHaveProperty("history");
    const last = await f.tasks.listTasks(peerOf(), { historyLength: 1 });
    expect(last.tasks[0]?.history?.map((message) => message.role)).toEqual([
      "ROLE_AGENT",
    ]);
  });
});

describe("status messages", () => {
  test("an AUTH_REQUIRED task carries a plain status message", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(plainStatusProblems(read)).toEqual([]);
  });

  test("a SUBMITTED task carries a plain status message", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    const approved = await f.tasks.approveTask(member(), task.id);
    expect(approved.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(plainStatusProblems(approved)).toEqual([]);
  });

  test("a WORKING task carries a plain status message", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.status.state).toBe("TASK_STATE_WORKING");
    expect(plainStatusProblems(read)).toEqual([]);
  });

  test("an INPUT_REQUIRED task carries a plain status message with the question", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    await f.requests.open(f.system, {
      kind: "question",
      questions: [
        { choices: ["red", "blue"], question: "Which colour do you want?" },
      ],
      runId: run?.id ?? "",
      toolName: "AskUserQuestion",
      toolUseId: "q1",
    });
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(plainStatusProblems(read)).toEqual([]);
    expect(statusText(read)).toContain("Which colour do you want?");
  });

  test("a COMPLETED task has the result as an artifact and no status message", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    await f.runs.completeRun(f.system, run?.id ?? "", {
      status: "done",
      text: "Hi!",
    });
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.status.state).toBe("TASK_STATE_COMPLETED");
    expect(read.artifacts?.[0]?.parts).toEqual([
      { mediaType: "text/plain", text: "Hi!" },
    ]);
    expect(read.status.message).toBeUndefined();
  });

  test("a COMPLETED task whose run returned no text says so and has no artifact", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    await f.runs.completeRun(f.system, run?.id ?? "", {
      status: "done",
      text: "",
    });
    const read = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(read.status.state).toBe("TASK_STATE_COMPLETED");
    expect(read).not.toHaveProperty("artifacts");
    expect(plainStatusProblems(read)).toEqual([]);
    expect(statusText(read)).toContain("no text");
  });
});

describe("task timestamp", () => {
  test("status.timestamp is an ISO string ending in Z and moves when the state changes", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    expect(task.status.timestamp).toBe(START);

    f.advance(MINUTE_MS);
    const submitted = await f.tasks.approveTask(member(), task.id);
    expect(submitted.status.timestamp).toBe(at(MINUTE_MS));

    f.advance(MINUTE_MS);
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    const working = await f.tasks.getTask(peerOf(), { id: task.id });
    expect(working.status.timestamp).toBe(at(2 * MINUTE_MS));
    expect(working.status.timestamp).toMatch(ISO_UTC_MS);
  });
});

describe("listTasks filters", () => {
  test("contextId keeps only the tasks in that context", async () => {
    await f.connect();
    const inA = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hi", { contextId: "ctx-a" })
    );
    await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "Hi", { contextId: "ctx-b" })
    );
    const listed = await f.tasks.listTasks(peerOf(), { contextId: "ctx-a" });
    expect(listed.tasks.map((task) => task.id)).toEqual([inA.id]);
    expect(listed.totalSize).toBe(1);
  });

  test("status keeps only the tasks in that state", async () => {
    await f.connect();
    const waiting = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hi")
    );
    const declined = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "Hi")
    );
    await f.tasks.declineTask(member(), declined.id);
    const awaiting = await f.tasks.listTasks(peerOf(), {
      status: "TASK_STATE_AUTH_REQUIRED",
    });
    expect(awaiting.tasks.map((task) => task.id)).toEqual([waiting.id]);
    const rejected = await f.tasks.listTasks(peerOf(), {
      status: "TASK_STATE_REJECTED",
    });
    expect(rejected.tasks.map((task) => task.id)).toEqual([declined.id]);
  });

  test("statusTimestampAfter keeps only the tasks whose status changed after that time", async () => {
    await f.connect();
    await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    f.advance(MINUTE_MS);
    const newer = await f.tasks.sendMessage(peerOf(), textMessage("m2", "Hi"));
    const listed = await f.tasks.listTasks(peerOf(), {
      statusTimestampAfter: at(MINUTE_MS / 2),
    });
    expect(listed.tasks.map((task) => task.id)).toEqual([newer.id]);
  });

  test("artifacts come back only when includeArtifacts is true", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
    const run = await runOf(task.id);
    await f.runs.claimRun(f.system, run?.id ?? "");
    await f.runs.completeRun(f.system, run?.id ?? "", {
      status: "done",
      text: "Hi!",
    });
    const without = await f.tasks.listTasks(peerOf());
    expect(without.tasks[0]).not.toHaveProperty("artifacts");
    const withArtifacts = await f.tasks.listTasks(peerOf(), {
      includeArtifacts: true,
    });
    expect(withArtifacts.tasks[0]?.artifacts).toHaveLength(1);
  });
});

describe("listTasks pages", () => {
  /** Five tasks, a minute apart, oldest first. */
  const fiveTasks = async () => {
    await f.connect();
    const ids: string[] = [];
    for (const i of [1, 2, 3, 4, 5]) {
      if (i > 1) {
        f.advance(MINUTE_MS);
      }
      // biome-ignore lint/performance/noAwaitInLoops: each send is stamped with the clock as it stands, so they run in order
      const task = await f.tasks.sendMessage(
        peerOf(),
        textMessage(`m${i}`, `Message ${i}`)
      );
      ids.push(task.id);
    }
    return ids;
  };

  test("pages run newest first, the last page has an empty token, and totalSize is the whole list", async () => {
    const newestFirst = (await fiveTasks()).reverse();
    const first = await f.tasks.listTasks(peerOf(), { pageSize: 2 });
    expect(first.tasks.map((task) => task.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.nextPageToken).not.toBe("");
    expect(first.totalSize).toBe(5);

    const second = await f.tasks.listTasks(peerOf(), {
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.tasks.map((task) => task.id)).toEqual(
      newestFirst.slice(2, 4)
    );
    expect(second.nextPageToken).not.toBe("");
    expect(second.totalSize).toBe(5);

    const last = await f.tasks.listTasks(peerOf(), {
      pageSize: 2,
      pageToken: second.nextPageToken,
    });
    expect(last.tasks.map((task) => task.id)).toEqual(newestFirst.slice(4));
    expect(last.nextPageToken).toBe("");
    expect(last.totalSize).toBe(5);
  });

  test("a pageSize of 0 or 101 is refused by schema validation", async () => {
    await fiveTasks();
    const errors = await Promise.all(
      [0, 101].map((pageSize) =>
        rejects(f.tasks.listTasks(peerOf(), { pageSize }))
      )
    );
    for (const error of errors) {
      expect((error as Error).name).toBe("ZodError");
    }
  });

  test("a garbled pageToken is refused as invalid", async () => {
    await fiveTasks();
    const errors = await Promise.all(
      ["!!not a token!!", btoa("no-separator")].map((pageToken) =>
        rejects(f.tasks.listTasks(peerOf(), { pageToken }))
      )
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("invalid");
    }
  });

  test("tasks changed in the same millisecond page without a skip or a repeat", async () => {
    const ids = await fiveTasks();
    const tied = at(10 * MINUTE_MS);
    await Promise.all(
      ids
        .slice(1, 4)
        .map((id) =>
          f.db
            .update(a2aTasks)
            .set({ updatedAt: tied })
            .where(eq(a2aTasks.id, id))
        )
    );

    const seen: string[] = [];
    let pageToken: string | undefined;
    do {
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the token the page before it returned
      const listed = await f.tasks.listTasks(peerOf(), {
        pageSize: 2,
        pageToken,
      });
      seen.push(...listed.tasks.map((task) => task.id));
      pageToken =
        listed.nextPageToken === "" ? undefined : listed.nextPageToken;
    } while (pageToken !== undefined && seen.length <= ids.length);

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe("getTask on a missing task", () => {
  test("is A2aTaskError with errorName TaskNotFoundError", async () => {
    await f.connect();
    const error = await rejects(
      f.tasks.getTask(peerOf(), { id: "tsk_missing" })
    );
    expect(error).toBeInstanceOf(A2aTaskError);
    expect((error as A2aTaskError).errorName).toBe("TaskNotFoundError");
  });
});
