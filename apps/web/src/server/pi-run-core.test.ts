import { describe, expect, spyOn, test } from "bun:test";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { RunStatus } from "@repo/db/shared";
import type { CloudStart } from "@repo/services/cloud/types";
import { ServiceError } from "@repo/services/errors";
import type { RunEventInput, RunResult } from "@repo/services/runs/types";
import {
  createRunCore,
  type PiOutcome,
  type PiPort,
  type RunOutputs,
  type RunRef,
  type RunStorage,
  SERVERS_KEY,
} from "./pi-run-core.ts";
import type { PiInput } from "./pi-run-files.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const defer = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Lets queued promise work finish: a few macrotasks. */
const settle = async () => {
  for (let round = 0; round < 5; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round waits for the one before
    await tick();
  }
};

const memoryStorage = (): RunStorage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    delete: (key: string) => Promise.resolve(data.delete(key)),
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
};

const zeroUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0.5 },
  input: 10,
  output: 4,
  totalTokens: 14,
};

const assistant = (
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  api: "anthropic-messages",
  content,
  model: "test-model",
  provider: "anthropic",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: zeroUsage,
  ...extra,
});

interface Submitted {
  operationId: string;
  text: string;
  whenBusy: "followUp" | "steer";
}

/** The text of an input, whatever blocks go with it. */
const textOfInput = (input: PiInput): string =>
  typeof input === "string"
    ? input
    : input.map((part) => (part.type === "text" ? part.text : "")).join("");

/** Pi, reduced to what the runner sees: a transcript, submissions that settle when the test says so, and commit callbacks. */
const createFakePi = () => {
  const entries: EntryRecord[] = [];
  const submissions = new Map<
    string,
    { entry: number; outcome: Deferred<PiOutcome>; settled: boolean }
  >();
  const watchers = new Set<() => Promise<void>>();
  const submitted: Submitted[] = [];
  const inputs: PiInput[] = [];
  const aborted: string[] = [];
  const models: string[] = [];
  const instructions: string[] = [];
  let nextId = 1;

  const append = (...model: Message[]): number => {
    const id = nextId;
    nextId += 1;
    entries.push({
      conversationId: "c" as unknown as EntryRecord["conversationId"],
      id: id as unknown as EntryRecord["id"],
      kind: "turn",
      model,
    });
    return id;
  };

  const commit = async () => {
    await Promise.all([...watchers].map((watcher) => watcher()));
  };

  const pi: PiPort = {
    abort: (operationId) => {
      aborted.push(operationId);
      const submission = submissions.get(operationId);
      if (submission && !submission.settled) {
        submission.settled = true;
        submission.outcome.resolve({ reason: "aborted", status: "unanswered" });
      }
      return Promise.resolve(true);
    },
    busy: () =>
      Promise.resolve([...submissions.values()].some((s) => !s.settled)),
    entriesFrom: (start) =>
      Promise.resolve(
        entries.filter((entry) => Number(entry.id) >= Number(start))
      ),
    entryOf: (operationId) => {
      const submission = submissions.get(operationId);
      return Promise.resolve(submission ? String(submission.entry) : undefined);
    },
    setInstructions: (text) => {
      instructions.push(text);
      return Promise.resolve();
    },
    setModel: (model) => {
      models.push(model);
      return Promise.resolve();
    },
    submit: async (input, options) => {
      const text = textOfInput(input);
      submitted.push({ ...options, text });
      inputs.push(input);
      if (submissions.has(options.operationId)) {
        return { accepted: false };
      }
      const entry = append({ content: text, role: "user", timestamp: 0 });
      submissions.set(options.operationId, {
        entry,
        outcome: defer<PiOutcome>(),
        settled: false,
      });
      await commit();
      return { accepted: true };
    },
    wait: (operationId) => {
      const submission = submissions.get(operationId);
      if (!submission) {
        return Promise.resolve({ reason: "not_found", status: "unanswered" });
      }
      return submission.outcome.promise;
    },
    watch: (onChange) => {
      watchers.add(onChange);
      return Promise.resolve(() => {
        watchers.delete(onChange);
        return Promise.resolve();
      });
    },
  };

  return {
    aborted,
    commit,
    /** Settles a run the way Pi does. */
    finish: (operationId: string, outcome: PiOutcome) => {
      const submission = submissions.get(operationId);
      if (submission && !submission.settled) {
        submission.settled = true;
        submission.outcome.resolve(outcome);
      }
    },
    inputs,
    instructions,
    models,
    pi,
    /** The model says something. */
    say: async (text: string) => {
      append(assistant([{ text, type: "text" }]));
      await commit();
    },
    /** The model fails. */
    sayError: async (message: string) => {
      append(
        assistant([], {
          errorMessage: message,
          stopReason: "error",
          usage: { ...zeroUsage, cost: { ...zeroUsage.cost, total: 0 } },
        })
      );
      await commit();
    },
    sayTool: async (id: string, name: string, result: string) => {
      append(
        assistant([{ arguments: { q: 1 }, id, name, type: "toolCall" }], {
          stopReason: "toolUse",
        })
      );
      const toolResult: ToolResultMessage = {
        content: [{ text: result, type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: 0,
        toolCallId: id,
        toolName: name,
      };
      append(toolResult);
      await commit();
    },
    submitted,
  };
};

const withInstructions = (
  input: CloudStart,
  instructions: string
): CloudStart => ({
  ...input,
  agent: { ...input.agent, instructions },
});

const startOf = (runId: string, text = "hello"): CloudStart => ({
  agent: {
    id: "agent-1",
    instructions: "Be brief.",
    model: "claude-test",
    name: "Agent",
    runtimeConfig: {},
    slug: "agent",
  },
  inputFileIds: [],
  mcpServers: {
    harbourmaster: {
      headers: { Authorization: `Bearer token-${runId}` },
      type: "http",
      url: "https://hm.test/mcp",
    },
  },
  run: {
    agentId: "agent-1",
    id: runId,
    inputText: text,
    sessionId: "session-1",
    workspaceId: "workspace-1",
  },
  runToken: `token-${runId}`,
});

interface Harness {
  completed: { result: RunResult; runId: string }[];
  core: ReturnType<typeof createRunCore>;
  fake: ReturnType<typeof createFakePi>;
  heartbeats: string[];
  ingested: { events: RunEventInput[]; runId: string }[];
  inputs: { fileIds: readonly string[]; run: RunRef; text: string }[];
  installed: string[];
  maxInFlight: () => number;
  outputs: { run: RunRef; text: string }[];
  skillsInstalled: string[];
  storage: ReturnType<typeof memoryStorage>;
}

const build = (
  options: {
    complete?: (runId: string, result: RunResult) => Promise<void>;
    fake?: ReturnType<typeof createFakePi>;
    heartbeat?: (runId: string) => Promise<void>;
    ingest?: (runId: string, events: RunEventInput[]) => Promise<void>;
    inputOf?: (
      run: RunRef,
      text: string,
      fileIds: readonly string[]
    ) => Promise<PiInput>;
    installSkills?: () => Promise<void>;
    modelError?: (model: string) => string | undefined;
    now?: () => number;
    outputsOf?: (run: RunRef, text: string) => Promise<RunOutputs>;
    status?: () => RunStatus;
    storage?: ReturnType<typeof memoryStorage>;
  } = {}
): Harness => {
  const fake = options.fake ?? createFakePi();
  const storage = options.storage ?? memoryStorage();
  const completed: Harness["completed"] = [];
  const ingested: Harness["ingested"] = [];
  const heartbeats: string[] = [];
  const installed: string[] = [];
  const skillsInstalled: string[] = [];
  const inputs: Harness["inputs"] = [];
  const outputs: Harness["outputs"] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const core = createRunCore({
    complete: async (runId, result) => {
      await options.complete?.(runId, result);
      completed.push({ result, runId });
    },
    heartbeat: async (runId) => {
      heartbeats.push(runId);
      await options.heartbeat?.(runId);
    },
    ingest: async (runId, events) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      try {
        await options.ingest?.(runId, events);
        ingested.push({ events, runId });
      } finally {
        inFlight -= 1;
      }
    },
    inputOf: (run, text, fileIds) => {
      inputs.push({ fileIds, run, text });
      return options.inputOf?.(run, text, fileIds) ?? Promise.resolve(text);
    },
    installSkills: async (input) => {
      skillsInstalled.push(input.run.id);
      await options.installSkills?.();
    },
    installTools: (input) => {
      installed.push(input.run.id);
      return Promise.resolve();
    },
    modelError: options.modelError ?? (() => undefined),
    now: options.now,
    outputsOf: (run, text) => {
      outputs.push({ run, text });
      return (
        options.outputsOf?.(run, text) ?? Promise.resolve({ fileIds: [], text })
      );
    },
    pi: fake.pi,
    sleep: () => Promise.resolve(),
    statusOf: async () =>
      await Promise.resolve(options.status?.() ?? "cancelled"),
    storage,
  });
  return {
    completed,
    core,
    fake,
    heartbeats,
    ingested,
    inputs,
    installed,
    maxInFlight: () => maxInFlight,
    outputs,
    skillsInstalled,
    storage,
  };
};

/** Every event the harness sent for a run, in order. */
const sentFor = (h: Harness, runId: string): RunEventInput[] =>
  h.ingested.filter((call) => call.runId === runId).flatMap((c) => c.events);

const conflict = () =>
  new ServiceError("conflict", "Run is cancelled, not running");

describe("start", () => {
  test("submits the input under the run id, sets the model, reports and completes", async () => {
    const h = build();
    await h.core.start(startOf("run-1", "hi there"));
    expect(await h.storage.get(SERVERS_KEY)).toEqual(
      startOf("run-1").mcpServers
    );
    expect(h.fake.submitted).toEqual([
      { operationId: "run-1", text: "hi there", whenBusy: "followUp" },
    ]);
    expect(h.fake.models).toEqual(["claude-test"]);
    await h.fake.say("hello back");
    h.fake.finish("run-1", { status: "done", text: "hello back" });
    await settle();

    expect(sentFor(h, "run-1")).toEqual([
      { payload: { text: "hello back" }, seq: 1, type: "message.assistant" },
    ]);
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]?.result).toMatchObject({
      status: "done",
      text: "hello back",
      usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 4 },
    });
  });

  test("a second start of the same run adds no events and no second completion", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.fake.say("one");
    await h.core.start(startOf("run-1"));
    await h.fake.say("two");
    h.fake.finish("run-1", { status: "done", text: "two" });
    await settle();

    expect(h.installed).toEqual(["run-1"]);
    expect(h.fake.submitted.map((s) => s.operationId)).toEqual([
      "run-1",
      "run-1",
    ]);
    const seqs = sentFor(h, "run-1").map((event) => event.seq);
    expect(seqs).toEqual([1, 2]);
    expect(h.completed).toHaveLength(1);
  });

  test("a second start refreshes the run token", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    const again = startOf("run-1");
    again.mcpServers.harbourmaster = {
      headers: { Authorization: "Bearer fresh" },
      type: "http",
      url: "https://hm.test/mcp",
    };
    await h.core.start(again);
    expect(
      (await h.storage.get<CloudStart["mcpServers"]>(SERVERS_KEY))
        ?.harbourmaster?.headers
    ).toEqual({ Authorization: "Bearer fresh" });
  });

  test("two starts at the same moment install the tools once and submit once as new", async () => {
    const h = build();
    await Promise.all([
      h.core.start(startOf("run-1")),
      h.core.start(startOf("run-1")),
    ]);
    expect(h.installed).toEqual(["run-1"]);
    expect(await h.storage.get("runs")).toEqual(["run-1"]);
  });

  test("a start whose tools cannot be listed stores nothing", async () => {
    const fake = createFakePi();
    const storage = memoryStorage();
    const core = createRunCore({
      complete: () => Promise.resolve(),
      heartbeat: () => Promise.resolve(),
      ingest: () => Promise.resolve(),
      inputOf: (_run, text) => Promise.resolve(text),
      installSkills: () => Promise.resolve(),
      installTools: () => Promise.reject(new Error("tools/list failed")),
      modelError: () => undefined,
      outputsOf: (_run, text) => Promise.resolve({ fileIds: [], text }),
      pi: fake.pi,
      statusOf: () => Promise.resolve("running"),
      storage,
    });
    await expect(core.start(startOf("run-1"))).rejects.toThrow("tools/list");
    expect(storage.data.size).toBe(0);
    expect(fake.submitted).toEqual([]);
  });
});

describe("two runs in one session", () => {
  test("each run reports only its own slice, numbered from 1", async () => {
    const h = build();
    await h.core.start(startOf("run-1", "first"));
    await h.fake.say("answer one");
    h.fake.finish("run-1", { status: "done", text: "answer one" });
    await settle();

    await h.core.start(startOf("run-2", "second"));
    await h.fake.sayTool("call-1", "bash", "file.txt");
    await h.fake.say("answer two");
    h.fake.finish("run-2", { status: "done", text: "answer two" });
    await settle();

    expect(sentFor(h, "run-1").map((e) => [e.seq, e.type])).toEqual([
      [1, "message.assistant"],
    ]);
    expect(sentFor(h, "run-2").map((e) => [e.seq, e.type])).toEqual([
      [1, "tool.call"],
      [2, "tool.result"],
      [3, "message.assistant"],
    ]);
    expect(h.completed.map((c) => [c.runId, c.result.text])).toEqual([
      ["run-1", "answer one"],
      ["run-2", "answer two"],
    ]);
  });

  test("a run that starts while the session is busy joins it, and the first run stops at the second's input", async () => {
    const h = build();
    await h.core.start(startOf("run-1", "first"));
    await h.fake.say("working");
    await h.core.start(startOf("run-2", "change of plan"));
    expect(h.fake.submitted.at(-1)).toMatchObject({
      operationId: "run-2",
      whenBusy: "steer",
    });
    await h.fake.say("new plan");
    h.fake.finish("run-1", { status: "done" });
    h.fake.finish("run-2", { status: "done" });
    await settle();

    expect(sentFor(h, "run-1").map((e) => e.payload)).toEqual([
      { text: "working" },
    ]);
    expect(sentFor(h, "run-2").map((e) => [e.seq, e.payload])).toEqual([
      [1, { text: "new plan" }],
    ]);
    expect(h.completed.map((c) => [c.runId, c.result.text])).toEqual([
      ["run-1", "working"],
      ["run-2", "new plan"],
    ]);
  });
});

describe("serial flush", () => {
  test("a burst of commits never has two writes in flight, and no seq is sent twice", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await Promise.all([
      h.fake.say("a"),
      h.fake.say("b"),
      h.fake.say("c"),
      h.fake.say("d"),
    ]);
    h.fake.finish("run-1", { status: "done", text: "d" });
    await settle();

    expect(h.maxInFlight()).toBe(1);
    const seqs = sentFor(h, "run-1").map((event) => event.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

describe("model failure", () => {
  test("fails the run with the model's error text", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.fake.sayError("overloaded_error: try later");
    h.fake.finish("run-1", { reason: "failed", status: "unanswered" });
    await settle();

    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]?.result).toMatchObject({
      error: "overloaded_error: try later",
      status: "failed",
    });
  });

  test("uses Pi's reason when the transcript has no error text", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { reason: "no_model", status: "unanswered" });
    await settle();
    expect(h.completed[0]?.result).toMatchObject({
      error: "no_model",
      status: "failed",
    });
  });
});

describe("instructions", () => {
  test("reach Pi before the first submit", async () => {
    const fake = createFakePi();
    let seenBySubmit: string[] = [];
    const h = build({
      fake,
      inputOf: () => {
        seenBySubmit = [...fake.instructions];
        return Promise.resolve("hello");
      },
    });
    await h.core.start(startOf("run-1"));
    expect(seenBySubmit).toEqual(["Be brief."]);
    expect(h.fake.submitted).toHaveLength(1);
  });

  test("a later run of the session sends the agent's changed instructions", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "one" });
    await settle();
    await h.core.start(
      withInstructions(startOf("run-2", "second"), "Be thorough.")
    );
    expect(h.fake.instructions).toEqual(["Be brief.", "Be thorough."]);
  });
});

describe("a model that cannot run", () => {
  test("fails the run with the model error and sets up nothing in Pi", async () => {
    const h = build({ modelError: (model) => `Unknown model ${model}` });
    await h.core.start(startOf("run-1"));

    expect(h.completed).toEqual([
      {
        result: { error: "Unknown model claude-test", status: "failed" },
        runId: "run-1",
      },
    ]);
    expect(h.fake.submitted).toEqual([]);
    expect(h.fake.models).toEqual([]);
    expect(h.fake.instructions).toEqual([]);
    expect(h.installed).toEqual([]);
  });

  test("a completion that starts the next run of the session does not wait on its own start", async () => {
    // The platform offers the next waiting run when a run ends, and it starts on this same object.
    let h: Harness | undefined;
    h = build({
      complete: async (runId) => {
        if (runId === "run-1") {
          await h?.core.start(startOf("run-2"));
        }
      },
      modelError: (model) => `Unknown model ${model}`,
    });
    await h.core.start(startOf("run-1"));

    expect(h.completed.map((call) => call.runId)).toEqual(["run-2", "run-1"]);
  });

  test("a valid model completes nothing at start", async () => {
    const h = build({ modelError: () => undefined });
    await h.core.start(startOf("run-1"));
    expect(h.completed).toEqual([]);
    expect(h.fake.submitted).toHaveLength(1);
  });
});

describe("cancel", () => {
  test("aborts the operation and treats the platform's refusal as the end", async () => {
    const h = build({
      complete: () => Promise.reject(conflict()),
    });
    await h.core.start(startOf("run-1"));
    await h.core.cancel("run-1");
    await settle();

    expect(h.fake.aborted).toEqual(["run-1"]);
    expect(h.completed).toEqual([]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
  });

  test("a run this object never saw is ignored", async () => {
    const h = build();
    await h.core.cancel("run-unknown");
    expect(h.fake.aborted).toEqual([]);
  });

  test("a run that already finished is ignored", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "x" });
    await settle();
    await h.core.cancel("run-1");
    expect(h.fake.aborted).toEqual([]);
  });

  test("a run the platform no longer runs is aborted when an event is refused", async () => {
    const h = build({ ingest: () => Promise.reject(conflict()) });
    await h.core.start(startOf("run-1"));
    await h.fake.say("late");
    await settle();

    expect(h.fake.aborted).toEqual(["run-1"]);
    expect(h.completed).toEqual([]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
  });
});

describe("a run the platform put back for another claim", () => {
  test("keeps working when an event is refused, and sends everything once the run runs again", async () => {
    const gate: { refuse: boolean } = { refuse: true };
    const h = build({
      ingest: () =>
        gate.refuse ? Promise.reject(conflict()) : Promise.resolve(),
      status: () => "offered",
    });
    await h.core.start(startOf("run-1"));
    await h.fake.say("a");
    expect(h.fake.aborted).toEqual([]);
    gate.refuse = false;
    await h.fake.say("b");
    h.fake.finish("run-1", { status: "done", text: "b" });
    await settle();

    expect(sentFor(h, "run-1").map((event) => event.seq)).toEqual([1, 2]);
    expect(h.completed).toHaveLength(1);
  });

  test("leaves the run active when completing is refused, and a second start reports it", async () => {
    const gate: { refuse: boolean } = { refuse: true };
    const h = build({
      complete: () =>
        gate.refuse ? Promise.reject(conflict()) : Promise.resolve(),
      status: () => "offered",
    });
    await h.core.start(startOf("run-1"));
    await h.fake.say("done");
    h.fake.finish("run-1", { status: "done", text: "done" });
    await settle();
    expect(h.completed).toEqual([]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "active",
    });

    // The sweep offers the run again, the platform claims it, and start runs once more.
    gate.refuse = false;
    await h.core.start(startOf("run-1"));
    await settle();
    expect(h.completed.map((c) => c.runId)).toEqual(["run-1"]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
  });
});

describe("a platform that fails while the runner reads the run's status", () => {
  test("one failed read does not stop the reports that follow", async () => {
    let reads = 0;
    const h = build({
      ingest: () =>
        reads < 2 ? Promise.reject(conflict()) : Promise.resolve(),
      status: () => {
        reads += 1;
        if (reads === 1) {
          throw new Error("D1 is busy");
        }
        return "offered";
      },
    });
    await h.core.start(startOf("run-1"));
    await h.fake.say("a");
    await h.fake.say("b");
    h.fake.finish("run-1", { status: "done", text: "b" });
    await settle();

    expect(sentFor(h, "run-1").map((event) => event.seq)).toEqual([1, 2]);
    expect(h.completed).toHaveLength(1);
  });

  test("a run claimed again between the refusal and the read still completes", async () => {
    let refusals = 1;
    const h = build({
      complete: () => {
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(conflict());
        }
        return Promise.resolve();
      },
      status: () => "running",
    });
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();

    expect(h.fake.aborted).toEqual([]);
    expect(h.completed).toHaveLength(1);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
  });
});

describe("the last report", () => {
  test("is tried again, so the result is built from everything Pi committed", async () => {
    let calls = 0;
    const h = build({
      ingest: () => {
        calls += 1;
        return calls <= 2
          ? Promise.reject(new Error("D1 is busy"))
          : Promise.resolve();
      },
    });
    await h.core.start(startOf("run-1"));
    await h.fake.say("the answer");
    h.fake.finish("run-1", { status: "done", text: "the answer" });
    await settle();

    expect(sentFor(h, "run-1").map((event) => event.seq)).toEqual([1]);
    expect(h.completed.map((c) => c.result.text)).toEqual(["the answer"]);
  });

  test("keeps the run active, and completes nothing, when it keeps failing", async () => {
    const h = build({ ingest: () => Promise.reject(new Error("D1 is down")) });
    await h.core.start(startOf("run-1"));
    await h.fake.say("the answer");
    h.fake.finish("run-1", { status: "done", text: "the answer" });
    await settle();

    expect(h.completed).toEqual([]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "active",
    });
  });
});

describe("the run token", () => {
  test("is dropped when the last active run finishes, and kept while another works", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.core.start(startOf("run-2", "second"));
    h.fake.finish("run-1", { status: "done", text: "one" });
    await settle();
    expect(await h.storage.get(SERVERS_KEY)).toBeDefined();

    h.fake.finish("run-2", { status: "done", text: "two" });
    await settle();
    expect(await h.storage.get(SERVERS_KEY)).toBeUndefined();
  });
});

describe("completion", () => {
  test("retries a failure that is not a refusal", async () => {
    let attempts = 0;
    const h = build({
      complete: () => {
        attempts += 1;
        return attempts < 2
          ? Promise.reject(new Error("D1 is busy"))
          : Promise.resolve();
      },
    });
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
    expect(attempts).toBe(2);
    expect(h.completed).toHaveLength(1);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
  });

  test("leaves the run active when completing keeps failing, so a wake tries again", async () => {
    const h = build({ complete: () => Promise.reject(new Error("down")) });
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "active",
    });
  });

  test("no heartbeat goes out on a timer while the run is worked", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.heartbeats).toEqual([]);
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });
});

describe("beat", () => {
  test("heartbeats each active run once and none of the finished ones", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.core.start(startOf("run-2", "second"));
    h.fake.finish("run-1", { status: "done", text: "one" });
    await settle();

    await h.core.beat();
    expect(h.heartbeats).toEqual(["run-2"]);
    h.fake.finish("run-2", { status: "done", text: "two" });
    await settle();
  });

  test("returns false when nothing is active and true while a run is active", async () => {
    const h = build();
    expect(await h.core.beat()).toBe(false);

    await h.core.start(startOf("run-1"));
    expect(await h.core.beat()).toBe(true);

    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
    expect(await h.core.beat()).toBe(false);
  });

  test("a conflict from heartbeat is swallowed and the next run is still heartbeated", async () => {
    const h = build({
      heartbeat: (runId) =>
        runId === "run-1" ? Promise.reject(conflict()) : Promise.resolve(),
    });
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    await h.core.start(startOf("run-1"));
    await h.core.start(startOf("run-2", "second"));

    expect(await h.core.beat()).toBe(true);
    expect(h.heartbeats).toEqual(["run-1", "run-2"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    h.fake.finish("run-1", { status: "done", text: "one" });
    h.fake.finish("run-2", { status: "done", text: "two" });
    await settle();
  });

  test("another error is logged, and the beat still resolves and heartbeats the other runs", async () => {
    const h = build({
      heartbeat: (runId) =>
        runId === "run-1"
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(),
    });
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    await h.core.start(startOf("run-1"));
    await h.core.start(startOf("run-2", "second"));

    expect(await h.core.beat()).toBe(true);
    expect(h.heartbeats).toEqual(["run-1", "run-2"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("network down");
    spy.mockRestore();
    h.fake.finish("run-1", { status: "done", text: "one" });
    h.fake.finish("run-2", { status: "done", text: "two" });
    await settle();
  });

  test("a run older than 12 hours is not heartbeated, but is still worked again", async () => {
    let clock = 0;
    let refusals = 3;
    const h = build({
      complete: () => {
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(new Error("D1 is down"));
        }
        return Promise.resolve();
      },
      now: () => clock,
    });
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "late" });
    await settle();
    expect(h.completed).toEqual([]);

    clock = 12 * 60 * 60 * 1000 + 1;
    expect(await h.core.beat()).toBe(true);
    await settle();

    expect(h.heartbeats).toEqual([]);
    expect(
      h.fake.submitted.filter((s) => s.operationId === "run-1")
    ).toHaveLength(2);
    expect(h.completed.map((c) => c.runId)).toEqual(["run-1"]);
    spy.mockRestore();
  });

  test("an active run that is not followed is worked again by the next beat, then completes", async () => {
    let refusals = 3;
    const h = build({
      complete: () => {
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(new Error("D1 is down"));
        }
        return Promise.resolve();
      },
    });
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    await h.core.start(startOf("run-1"));
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
    expect(h.completed).toEqual([]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "active",
    });

    expect(await h.core.beat()).toBe(true);
    await settle();
    expect(h.completed.map((c) => c.result.text)).toEqual(["ok"]);
    expect(await h.storage.get("run:run-1")).toMatchObject({
      state: "finished",
    });
    expect(await h.core.beat()).toBe(false);
    spy.mockRestore();
  });

  test("a run that is followed is not submitted again by beat", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    expect(h.fake.submitted).toHaveLength(1);

    await h.core.beat();
    await settle();
    expect(h.heartbeats).toEqual(["run-1"]);
    expect(h.fake.submitted).toHaveLength(1);
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });
});

describe("resume", () => {
  test("submits a run again, on the agent's model, when its start stopped before the submit", async () => {
    const storage = memoryStorage();
    await storage.put("runs", ["run-1"]);
    await storage.put("run:run-1", {
      agentId: "agent-1",
      fileIds: [],
      instructions: "Be brief.",
      model: "claude-test",
      startedAt: 0,
      state: "active",
      text: "hello",
      workspaceId: "workspace-1",
    });
    const h = build({ storage });
    await h.core.resume();
    expect(h.fake.models).toEqual(["claude-test"]);
    expect(h.fake.submitted).toEqual([
      { operationId: "run-1", text: "hello", whenBusy: "followUp" },
    ]);
  });

  test("submits a run again with the instructions it was started with", async () => {
    const storage = memoryStorage();
    await storage.put("runs", ["run-1"]);
    await storage.put("run:run-1", {
      agentId: "agent-1",
      fileIds: [],
      instructions: "Stored text.",
      model: "claude-test",
      startedAt: 0,
      state: "active",
      text: "hello",
      workspaceId: "workspace-1",
    });
    const h = build({ storage });
    await h.core.resume();
    expect(h.fake.instructions).toEqual(["Stored text."]);
  });

  test("works the unfinished runs again after a wake and leaves finished ones", async () => {
    const first = build();
    await first.core.start(startOf("run-1"));
    first.fake.finish("run-1", { status: "done", text: "one" });
    await settle();
    await first.core.start(startOf("run-2", "second"));
    await first.fake.say("half way");
    await settle();
    expect(first.completed.map((c) => c.runId)).toEqual(["run-1"]);

    // The object is evicted: memory goes, storage and Pi's transcript stay.
    const second = build({ fake: first.fake, storage: first.storage });
    await second.core.resume();
    await second.fake.say("rest");
    first.fake.finish("run-2", { status: "done", text: "rest" });
    await settle();

    expect(second.completed.map((c) => c.runId)).toEqual(["run-2"]);
    // The new runner starts its count again, and the platform skips seqs it holds.
    expect(sentFor(second, "run-2").map((e) => e.seq)).toEqual([1, 2]);
    // The finished run was not submitted again.
    expect(
      second.fake.submitted.filter((s) => s.operationId === "run-1")
    ).toHaveLength(1);
  });
});

const withFiles = (
  runId: string,
  fileIds: string[],
  text = "look"
): CloudStart => ({
  ...startOf(runId, text),
  inputFileIds: fileIds,
});

const IMAGE_INPUT: PiInput = [
  { text: "look", type: "text" },
  { data: "aGk=", mimeType: "image/png", type: "image" },
];

describe("skills", () => {
  test("a run's skills are loaded once, and a repeated start does not load them again", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.core.start(startOf("run-1"));
    expect(h.skillsInstalled).toEqual(["run-1"]);
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });

  test("a start whose skills cannot be loaded goes on without them", async () => {
    const spy = spyOn(console, "warn").mockImplementation(() => undefined);
    const h = build({
      installSkills: () => Promise.reject(new Error("skills list 500")),
    });
    await h.core.start(startOf("run-1"));
    expect(h.fake.submitted.map((s) => s.operationId)).toEqual(["run-1"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });
});

describe("input files", () => {
  test("the message Pi gets is what inputOf builds from the run's files", async () => {
    const h = build({ inputOf: () => Promise.resolve(IMAGE_INPUT) });
    await h.core.start(withFiles("run-1", ["file-1", "file-2"]));
    expect(h.inputs).toEqual([
      {
        fileIds: ["file-1", "file-2"],
        run: {
          agentId: "agent-1",
          runId: "run-1",
          workspaceId: "workspace-1",
        },
        text: "look",
      },
    ]);
    expect(h.fake.inputs).toEqual([IMAGE_INPUT]);
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });

  test("a run submitted again after a wake sends its files again", async () => {
    const h = build({ inputOf: () => Promise.resolve(IMAGE_INPUT) });
    await h.core.start(withFiles("run-1", ["file-1"]));
    const second = build({
      fake: h.fake,
      inputOf: () => Promise.resolve(IMAGE_INPUT),
      storage: h.storage,
    });
    await second.core.resume();
    expect(second.inputs.map((call) => call.fileIds)).toEqual([["file-1"]]);
    expect(h.fake.inputs.at(-1)).toEqual(IMAGE_INPUT);
    h.fake.finish("run-1", { status: "done", text: "ok" });
    await settle();
  });
});

describe("output files", () => {
  test("a finished run completes with the uploaded files and the cleaned answer", async () => {
    const h = build({
      outputsOf: () =>
        Promise.resolve({ fileIds: ["out-1", "out-2"], text: "Here you go" }),
    });
    await h.core.start(startOf("run-1"));
    await h.fake.say("Here you go\n[ATTACHMENT:/library/a.png]");
    h.fake.finish("run-1", { status: "done", text: "unused" });
    await settle();

    expect(h.outputs).toEqual([
      {
        run: {
          agentId: "agent-1",
          runId: "run-1",
          workspaceId: "workspace-1",
        },
        text: "Here you go\n[ATTACHMENT:/library/a.png]",
      },
    ]);
    expect(h.completed[0]?.result).toMatchObject({
      fileIds: ["out-1", "out-2"],
      status: "done",
      text: "Here you go",
    });
  });

  test("a failed run uploads nothing", async () => {
    const h = build();
    await h.core.start(startOf("run-1"));
    await h.fake.sayError("model down");
    h.fake.finish("run-1", { reason: "model down", status: "unanswered" });
    await settle();
    expect(h.outputs).toEqual([]);
    expect(h.completed[0]?.result.status).toBe("failed");
  });

  test("a completion that is tried again does not upload the files again", async () => {
    let refusals = 3;
    const h = build({
      complete: () => {
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(new Error("D1 is down"));
        }
        return Promise.resolve();
      },
      outputsOf: () => Promise.resolve({ fileIds: ["out-1"], text: "cleaned" }),
    });
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    await h.core.start(startOf("run-1"));
    await h.fake.say("done [ATTACHMENT:/library/a.txt]");
    h.fake.finish("run-1", { status: "done", text: "done" });
    await settle();
    expect(h.completed).toEqual([]);

    await h.core.beat();
    await settle();

    expect(h.outputs).toHaveLength(1);
    expect(h.completed.map((c) => c.result)).toMatchObject([
      { fileIds: ["out-1"], text: "cleaned" },
    ]);
    spy.mockRestore();
  });
});
