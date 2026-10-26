import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type HookApi,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { RequestOutcome } from "@repo/protocol/requests";
import {
  createGate,
  type Gate,
  type GateRequests,
  gateExtension,
  type OpenRequest,
  RULE_CACHE_MS,
} from "./pi-run-gate.ts";
import type { ToolOrigin } from "./pi-run-mcp.ts";

const RUN = "run1";
const ALLOW: RequestOutcome = {
  answer: { decision: "allow_once" },
  status: "answered",
};
const DENY: RequestOutcome = {
  answer: { decision: "deny", note: "Not on production." },
  status: "answered",
};
const EXPIRED: RequestOutcome = { status: "expired" };
const CANCELLED: RequestOutcome = { status: "cancelled" };
const DENIED_TEXT = "A person denied this call. Not on production.";

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Lets queued promise work finish. */
const settle = async () => {
  for (let round = 0; round < 5; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round waits for the one before
    await tick();
  }
};

/** Polls until the check holds or a second has passed. */
const until = async (check: () => boolean) => {
  for (let round = 0; round < 200 && !check(); round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

/** The requests service, reduced to what the gate calls. Closing a request is the test's job. */
const fakeRequests = (ruledKeys: readonly string[]) => {
  const rows: {
    id: string;
    outcome: RequestOutcome | null;
    toolUseId: string;
  }[] = [];
  const opens: OpenRequest[] = [];
  const ruleReads: string[] = [];
  const port: GateRequests = {
    needsApproval: ({ toolKey }) => {
      ruleReads.push(toolKey);
      return Promise.resolve(ruledKeys.includes(toolKey));
    },
    open: (input) => {
      opens.push(input);
      let row = rows.find((other) => other.toolUseId === input.toolUseId);
      if (!row) {
        row = {
          id: `req${rows.length + 1}`,
          outcome: null,
          toolUseId: input.toolUseId,
        };
        rows.push(row);
      }
      return Promise.resolve({ id: row.id, outcome: row.outcome });
    },
    outcome: (requestId) =>
      Promise.resolve(
        rows.find((row) => row.id === requestId)?.outcome ?? null
      ),
  };
  const close = (requestId: string, outcome: RequestOutcome) => {
    const row = rows.find((other) => other.id === requestId);
    if (row) {
      row.outcome = outcome;
    }
  };
  return { close, opens, port, rows, ruleReads };
};

const gateOf = (
  requests: GateRequests,
  options: {
    now?: () => number;
    origins?: Record<string, ToolOrigin>;
    serverKeys?: string[];
  } = {}
): Gate =>
  createGate({
    now: options.now,
    originOf: (name) => options.origins?.[name],
    requests,
    runIdOf: () => Promise.resolve(RUN),
    serverKeys: () => options.serverKeys ?? [],
  });

const callOf = (
  name: string,
  id = "call1",
  args: Record<string, string> = {}
): ToolHookCall => ({ arguments: args, id, name, type: "toolCall" });

// The gate reads nothing from the hook's api.
const HOOK_API = {} as HookApi;

/** The hook's outcome once it settles, or "pending" while it waits. */
const resultOf = async (
  pending: Promise<unknown>
): Promise<"pending" | { value: unknown }> => {
  let result: "pending" | { value: unknown } = "pending";
  pending.then((value) => {
    result = { value };
  });
  await settle();
  return result;
};

describe("the gate hook", () => {
  test("lets a tool with no rule run at once and opens nothing", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);

    const value = await gate.beforeTool(
      callOf("read"),
      HOOK_API,
      BACKGROUND_CONTEXT
    );

    expect(value).toBeUndefined();
    expect(fake.opens).toEqual([]);
    expect(fake.ruleReads).toEqual(["read"]);
  });

  test("opens one request for a ruled tool, waits, and lets the call through on allow", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);

    const hook = gate.beforeTool(
      callOf("bash", "call1", { command: "ls" }),
      HOOK_API,
      BACKGROUND_CONTEXT
    );

    expect(await resultOf(hook)).toBe("pending");
    expect(fake.opens).toEqual([
      {
        input: { command: "ls" },
        kind: "approval",
        runId: RUN,
        toolKey: "bash",
        toolName: "bash",
        toolUseId: "call1",
      },
    ]);
    fake.close("req1", ALLOW);
    gate.answered("req1");
    expect(await hook).toBeUndefined();
    expect(fake.rows).toHaveLength(1);
  });

  const blocking: [string, RequestOutcome, string][] = [
    ["deny", DENY, DENIED_TEXT],
    [
      "expiry",
      EXPIRED,
      "Nobody answered within the time limit, so the call did not run.",
    ],
    ["cancel", CANCELLED, "The call was withdrawn because the run is ending."],
  ];
  for (const [name, outcome, text] of blocking) {
    test(`blocks with the outcome text on ${name}`, async () => {
      const fake = fakeRequests(["bash"]);
      const gate = gateOf(fake.port);
      const hook = gate.beforeTool(
        callOf("bash"),
        HOOK_API,
        BACKGROUND_CONTEXT
      );
      await settle();
      fake.close("req1", outcome);
      gate.answered("req1");

      expect(await hook).toEqual({ block: text });
    });
  }

  test("a request that is closed already is not waited for", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);
    fake.rows.push({ id: "req1", outcome: ALLOW, toolUseId: "call1" });

    expect(
      await gate.beforeTool(callOf("bash"), HOOK_API, BACKGROUND_CONTEXT)
    ).toBeUndefined();
    expect(fake.opens).toHaveLength(1);
  });

  test("a gate built again after a restart finds the same request and waits for it", async () => {
    const fake = fakeRequests(["bash"]);
    const before = gateOf(fake.port);
    const lost = new AbortController();
    const first = before.beforeTool(
      callOf("bash"),
      HOOK_API,
      withAbortSignal(lost.signal, BACKGROUND_CONTEXT)
    );
    first.catch(() => undefined);
    await settle();

    // The object is evicted: its waiters are gone with it.
    lost.abort();
    const after = gateOf(fake.port);
    const second = after.beforeTool(
      callOf("bash"),
      HOOK_API,
      BACKGROUND_CONTEXT
    );

    expect(await resultOf(second)).toBe("pending");
    expect(fake.rows).toHaveLength(1);
    fake.close("req1", ALLOW);
    after.checkOpen();
    expect(await second).toBeUndefined();
  });

  test("a beat finds an answer whose wake was missed", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);
    const hook = gate.beforeTool(callOf("bash"), HOOK_API, BACKGROUND_CONTEXT);
    await settle();

    fake.close("req1", ALLOW);
    expect(await resultOf(hook)).toBe("pending");
    gate.checkOpen();

    expect(await hook).toBeUndefined();
  });

  test("a wake for another request leaves the wait alone", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);
    const hook = gate.beforeTool(callOf("bash"), HOOK_API, BACKGROUND_CONTEXT);
    await settle();

    gate.answered("req9");

    expect(await resultOf(hook)).toBe("pending");
    fake.close("req1", ALLOW);
    gate.answered("req1");
    expect(await hook).toBeUndefined();
  });

  test("an abort ends the wait with an error", async () => {
    const fake = fakeRequests(["bash"]);
    const gate = gateOf(fake.port);
    const controller = new AbortController();
    const context: Context = withAbortSignal(
      controller.signal,
      BACKGROUND_CONTEXT
    );
    const hook = gate.beforeTool(callOf("bash"), HOOK_API, context);
    await settle();

    controller.abort();

    await expect(hook).rejects.toBeDefined();
  });

  test("keys an MCP tool by the server and name it was listed with", async () => {
    const fake = fakeRequests(["my.server/Create Issue"]);
    const gate = gateOf(fake.port, {
      origins: {
        my_server_Create_Issue: { name: "Create Issue", server: "my.server" },
      },
      serverKeys: ["my.server"],
    });

    const hook = gate.beforeTool(
      callOf("my_server_Create_Issue"),
      HOOK_API,
      BACKGROUND_CONTEXT
    );

    expect(await resultOf(hook)).toBe("pending");
    expect(fake.ruleReads).toEqual(["my.server/Create Issue"]);
    expect(fake.opens[0]).toMatchObject({
      toolKey: "my.server/Create Issue",
      toolName: "my.server/Create Issue",
    });
  });

  test("keys a built-in tool by its shared name", async () => {
    const fake = fakeRequests([]);
    const gate = gateOf(fake.port);

    await gate.beforeTool(callOf("Bash"), HOOK_API, BACKGROUND_CONTEXT);
    await gate.beforeTool(callOf("web_fetch"), HOOK_API, BACKGROUND_CONTEXT);

    expect(fake.ruleReads).toEqual(["bash", "web_fetch"]);
  });

  test("reads the rules once for repeated calls, and again after an answer or the cache time", async () => {
    const fake = fakeRequests([]);
    let now = 0;
    const gate = gateOf(fake.port, { now: () => now });

    await gate.beforeTool(callOf("read", "a"), HOOK_API, BACKGROUND_CONTEXT);
    await gate.beforeTool(callOf("read", "b"), HOOK_API, BACKGROUND_CONTEXT);
    expect(fake.ruleReads).toHaveLength(1);

    gate.answered("req1");
    await gate.beforeTool(callOf("read", "c"), HOOK_API, BACKGROUND_CONTEXT);
    expect(fake.ruleReads).toHaveLength(2);

    now += RULE_CACHE_MS;
    await gate.beforeTool(callOf("read", "d"), HOOK_API, BACKGROUND_CONTEXT);
    expect(fake.ruleReads).toHaveLength(3);

    gate.checkOpen();
    await gate.beforeTool(callOf("read", "e"), HOOK_API, BACKGROUND_CONTEXT);
    expect(fake.ruleReads).toHaveLength(4);
  });

  test("does not gate ask_user", async () => {
    const fake = fakeRequests(["ask_user"]);
    const gate = gateOf(fake.port);

    expect(
      await gate.beforeTool(callOf("ask_user"), HOOK_API, BACKGROUND_CONTEXT)
    ).toBeUndefined();
    expect(fake.ruleReads).toEqual([]);
  });
});

describe("the ask_user tool", () => {
  const apiOf = (callId: string) => ({ callId }) as ToolExecutionApi;

  test("is replay safe and takes the shared definition", () => {
    const gate = gateOf(fakeRequests([]).port);

    expect(gate.askUser.name).toBe("ask_user");
    expect(gate.askUser.replay).toBe("safe");
  });

  test("opens a question request on the call id and returns the answers", async () => {
    const fake = fakeRequests([]);
    const gate = gateOf(fake.port);
    const run = gate.askUser.execute(
      { choices: ["red", "blue"], question: "Which colour?" },
      apiOf("call7"),
      BACKGROUND_CONTEXT
    );

    expect(await resultOf(run)).toBe("pending");
    expect(fake.opens).toEqual([
      {
        kind: "question",
        questions: [{ choices: ["red", "blue"], question: "Which colour?" }],
        runId: RUN,
        toolName: "ask_user",
        toolUseId: "call7",
      },
    ]);
    fake.close("req1", {
      answer: { answers: { "Which colour?": "blue" } },
      status: "answered",
    });
    gate.answered("req1");
    expect(await run).toEqual({
      isError: false,
      output: [{ text: "Q: Which colour? A: blue", type: "text" }],
    });
  });

  test("returns the expiry text as an error result", async () => {
    const fake = fakeRequests([]);
    const gate = gateOf(fake.port);
    const run = gate.askUser.execute(
      { question: "Which colour?" },
      apiOf("call7"),
      BACKGROUND_CONTEXT
    );
    await settle();

    fake.close("req1", EXPIRED);
    gate.answered("req1");

    expect(await run).toEqual({
      isError: true,
      output: [
        {
          text: "Nobody answered the question in time. Go on without it or stop and say what you need.",
          type: "text",
        },
      ],
    });
  });

  test("run again after a restart it finds its request and does not open a second", async () => {
    const fake = fakeRequests([]);
    const args = { question: "Which colour?" };
    const first = gateOf(fake.port).askUser.execute(
      args,
      apiOf("call7"),
      withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT)
    );
    first.catch(() => undefined);
    await settle();
    fake.close("req1", {
      answer: { answers: { "Which colour?": "red" } },
      status: "answered",
    });

    const again = await gateOf(fake.port).askUser.execute(
      args,
      apiOf("call7"),
      BACKGROUND_CONTEXT
    );

    expect(fake.rows).toHaveLength(1);
    expect(again.output).toEqual([
      { text: "Q: Which colour? A: red", type: "text" },
    ]);
  });
});

describe("the extension", () => {
  test("brings the hook, the tool and one sentence for the prompt", async () => {
    const extension = gateExtension(gateOf(fakeRequests([]).port));

    expect(extension.hooks).toHaveLength(1);
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["ask_user"]);
    const section = extension.sections?.[0];
    expect(section).toBeDefined();
    const text = await section?.render(
      {} as Parameters<NonNullable<typeof section>["render"]>[0],
      BACKGROUND_CONTEXT
    );
    expect(text).toContain("ask_user");
  });
});

// Through Pi Durable itself: the gate is only worth anything if the tool task
// runs the hook again after a restart and runs the tool no more than once.
describe("with Pi Durable", () => {
  const TOOL = "effect";

  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : (content as { text?: string }[])
          .map((part) => part.text ?? "")
          .join("");

  /** Calls the tool, then repeats what the tool result said. */
  const script = (context: TranscriptContext): AssistantMessage => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText(`saw:${textOf(last.content)}`)]);
    }
    return fauxAssistantMessage([fauxToolCall(TOOL, {})], {
      stopReason: "toolUse",
    });
  };

  /** One "process": a harness over the shared storage with its own gate. */
  const open = async (
    storage: Awaited<ReturnType<typeof openNodeJsonlStorage>> | MemoryStorage,
    requests: GateRequests,
    effects: { runs: number }
  ) => {
    const gate = gateOf(requests);
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 5 }, () => script));
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(gateExtension(gate));
    registry.install({
      name: "effects",
      tools: [
        {
          description: "A tool with an effect.",
          execute: () => {
            effects.runs += 1;
            return Promise.resolve({
              isError: false,
              output: [{ text: "did it", type: "text" as const }],
            });
          },
          name: TOOL,
          parameters: Type.Object({}),
        },
      ],
    });
    const harness = await Harness.open(
      storage,
      { models, registry },
      BACKGROUND_CONTEXT
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { modelId: faux.getModel().id, provider: faux.provider.id },
      },
    });
    return { gate, harness, root };
  };

  const finalText = async (
    root: Awaited<ReturnType<typeof open>>["root"]
  ): Promise<string> => {
    const page = await root.entries(
      { order: "ascending" },
      50,
      undefined,
      BACKGROUND_CONTEXT
    );
    const answers = page.items
      .map((entry) => entry.model?.[0])
      .filter((message) => message?.role === "assistant");
    return textOf(answers.at(-1)?.content);
  };

  test("a ruled tool waits for an answer, then runs once", async () => {
    const fake = fakeRequests([TOOL]);
    const effects = { runs: 0 };
    const { gate, harness, root } = await open(
      new MemoryStorage(),
      fake.port,
      effects
    );
    const submission = await root.submit(
      { content: "go", type: "input" },
      BACKGROUND_CONTEXT
    );
    await until(() => fake.opens.length > 0);
    await settle();
    expect(effects.runs).toBe(0);

    fake.close("req1", ALLOW);
    gate.answered("req1");
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    expect(effects.runs).toBe(1);
    expect(await finalText(root)).toBe("saw:did it");
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("a denied tool never runs and the model reads why", async () => {
    const fake = fakeRequests([TOOL]);
    const effects = { runs: 0 };
    const { gate, harness, root } = await open(
      new MemoryStorage(),
      fake.port,
      effects
    );
    const submission = await root.submit(
      { content: "go", type: "input" },
      BACKGROUND_CONTEXT
    );
    await until(() => fake.opens.length > 0);

    fake.close("req1", DENY);
    gate.answered("req1");
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    expect(effects.runs).toBe(0);
    expect(await finalText(root)).toContain(DENIED_TEXT);
    await harness.close(BACKGROUND_CONTEXT);
  });

  for (const answeredWhile of ["down", "up"] as const) {
    test(`a restart while the call waits keeps one request and runs the tool once (answered while ${answeredWhile})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-run-gate-"));
      mkdirSync(dir, { recursive: true });
      try {
        const fake = fakeRequests([TOOL]);
        const effects = { runs: 0 };
        const first = await open(
          await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
          fake.port,
          effects
        );
        const submission = await first.root.submit(
          { content: "go", type: "input" },
          BACKGROUND_CONTEXT
        );
        await until(() => fake.opens.length > 0);
        await settle();
        await first.harness.close(BACKGROUND_CONTEXT);
        if (answeredWhile === "down") {
          fake.close("req1", ALLOW);
        }

        const second = await open(
          await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
          fake.port,
          effects
        );
        second.harness.resume();
        await until(() => fake.opens.length > 1);
        if (answeredWhile === "up") {
          await settle();
          expect(effects.runs).toBe(0);
          fake.close("req1", ALLOW);
          second.gate.answered("req1");
        }
        const settled = await (
          await second.harness.submission(submission.id, BACKGROUND_CONTEXT)
        )?.wait(BACKGROUND_CONTEXT);

        expect(settled?.status).toBe("done");
        expect(fake.rows).toHaveLength(1);
        expect(effects.runs).toBe(1);
        await second.harness.close(BACKGROUND_CONTEXT);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });
  }
});
