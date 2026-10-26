// Tests for the approval gate: which calls wait for a person, what the request
// route receives, how each outcome and each failure ends the call, and the
// Claude Code options that carry the gate.
import { describe, expect, test } from "bun:test";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type {
  CreateRequestBody,
  CreateRequestResponse,
  WaitRequestResponse,
} from "@repo/protocol/machine";
import { createRequestBodySchema } from "@repo/protocol/machine";
import { outcomeText, type RequestOutcome } from "@repo/protocol/requests";
import { openInputSchema } from "../../../packages/services/src/requests/records.ts";
import {
  createApprovalGate,
  gateOptions,
  HOOK_TIMEOUT_SECONDS,
  MAX_RETRIES,
  type ToolCall,
  type Verdict,
} from "./approvals.ts";
import { nextBackoffMs } from "./backoff.ts";
import { type RunApi, RunApiError, UNREADABLE_ANSWER } from "./run-api.ts";

const FIXED_RANDOM = 0.5;
const random = (): number => FIXED_RANDOM;
const REQUEST_ID = "req_1";
const TOOL_USE_ID = "toolu_1";
const UNAVAILABLE = 503;
const NO_ANSWER = 0;
const CONFLICT = 409;
const FORBIDDEN = 403;
const INPUT_MAX_BYTES = 8192;
const OVERSIZE_COMMAND_CHARS = 9000;
const TRUNCATED_SUFFIX = "… [truncated]";
const PENDING_POLLS = 2;
const PLATFORM_REFUSED =
  "The platform could not take this request, so the call did not run.";
const encoder = new TextEncoder();

/** The denial text for an outcome that denies. The outcomes used here always have one. */
const denialText = (
  kind: "approval" | "question",
  outcome: RequestOutcome
): string => {
  const text = outcomeText(kind, outcome);
  if (text === null) {
    throw new Error(`no denial text for ${outcome.status}`);
  }
  return text;
};

const ALLOW_ONCE: RequestOutcome = {
  answer: { decision: "allow_once" },
  status: "answered",
};

const pendingCreate: CreateRequestResponse = {
  requestId: REQUEST_ID,
  status: "pending",
};
const pendingWait: WaitRequestResponse = { status: "pending" };

/** A wait answer that carries the outcome. */
const finished = (outcome: RequestOutcome): WaitRequestResponse => ({
  outcome,
  status: outcome.status,
});

const bashCall = (command = "ls"): ToolCall => ({
  input: { command },
  name: "Bash",
  toolUseId: TOOL_USE_ID,
});

const QUESTION_INPUT = {
  questions: [
    {
      header: "Color",
      multiSelect: false,
      options: [
        { description: "r", label: "Red" },
        { description: "b", label: "Blue" },
      ],
      question: "Which color?",
    },
  ],
};

const questionCall = (input: unknown = QUESTION_INPUT): ToolCall => ({
  input,
  name: "AskUserQuestion",
  toolUseId: TOOL_USE_ID,
});

/** A scripted answer: a value is returned, an Error is thrown. */
type Step<T> = T | Error;

interface Script {
  create?: Step<CreateRequestResponse>[];
  /** Keeps waitRequest pending until its signal aborts, instead of answering from `wait`. */
  hangWait?: boolean;
  rules?: readonly string[];
  serverKeys?: readonly string[];
  wait?: Step<WaitRequestResponse>[];
}

const takeStep = <T>(steps: Step<T>[] | undefined, route: string): T => {
  const step = steps?.shift();
  if (step === undefined) {
    throw new Error(`unscripted ${route} call`);
  }
  if (step instanceof Error) {
    throw step;
  }
  return step;
};

/** A gate over a fake run API that records its calls and answers from `script`. */
const harness = (script: Script = {}) => {
  const run = new AbortController();
  const creates: { body: CreateRequestBody; signal?: AbortSignal }[] = [];
  const waits: { requestId: string; signal?: AbortSignal }[] = [];
  const delays: number[] = [];
  const waiting = Promise.withResolvers<void>();
  const createSteps = [...(script.create ?? [])];
  const waitSteps = [...(script.wait ?? [])];

  const api: Pick<RunApi, "createRequest" | "waitRequest"> = {
    createRequest: (body, signal) => {
      creates.push({ body, signal });
      return Promise.resolve().then(() =>
        takeStep(createSteps, "createRequest")
      );
    },
    waitRequest: (requestId, signal) => {
      waits.push({ requestId, signal });
      waiting.resolve();
      if (script.hangWait) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve().then(() => takeStep(waitSteps, "waitRequest"));
    },
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    delays.push(ms);
    return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  };

  const gate = createApprovalGate({
    api,
    log: () => undefined,
    random,
    rules: script.rules ?? ["bash"],
    serverKeys: script.serverKeys ?? [],
    signal: run.signal,
    sleep,
  });

  return {
    creates,
    delays,
    gate,
    run,
    waiting: waiting.promise,
    waits,
  };
};

const reasonOf = (verdict: Verdict | undefined): string | undefined =>
  verdict?.kind === "deny" ? verdict.reason : undefined;

describe("createApprovalGate.decide", () => {
  test("leaves a call with no matching rule to the run", async () => {
    const h = harness({ rules: ["bash"] });

    const verdict = await h.gate.decide({
      input: { file_path: "/x" },
      name: "Read",
      toolUseId: TOOL_USE_ID,
    });

    expect(verdict).toBeUndefined();
    expect(h.creates).toHaveLength(0);
    expect(h.waits).toHaveLength(0);
  });

  test("raises an approval for a ruled call and polls until it is answered", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [
        ...Array.from({ length: PENDING_POLLS }, () => pendingWait),
        finished(ALLOW_ONCE),
      ],
    });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({ kind: "allow" });
    const [created] = h.creates;
    expect(created?.body).toEqual({
      display: {
        input: { command: "ls" },
        summary: "Run `ls`",
        toolKey: "bash",
        toolName: "Bash",
      },
      kind: "approval",
      toolName: "Bash",
      toolUseId: TOOL_USE_ID,
    });
    expect(h.waits.map((wait) => wait.requestId)).toEqual([
      REQUEST_ID,
      REQUEST_ID,
      REQUEST_ID,
    ]);
  });

  test("denies with the person's note when the answer is a deny", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [
        finished({
          answer: { decision: "deny", note: "too risky" },
          status: "answered",
        }),
      ],
    });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({
      kind: "deny",
      reason: "A person denied this call. too risky",
    });
  });

  const unanswered: RequestOutcome[] = [
    { status: "expired" },
    { status: "cancelled" },
  ];
  for (const outcome of unanswered) {
    test(`denies with the ${outcome.status} text`, async () => {
      const h = harness({
        create: [pendingCreate],
        wait: [finished(outcome)],
      });

      const verdict = await h.gate.decide(bashCall());

      expect(verdict).toEqual({
        kind: "deny",
        reason: denialText("approval", outcome),
      });
    });
  }

  test("uses an outcome that createRequest returns at once, without polling", async () => {
    const h = harness({
      create: [
        { outcome: ALLOW_ONCE, requestId: REQUEST_ID, status: "answered" },
      ],
    });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({ kind: "allow" });
    expect(h.waits).toHaveLength(0);
  });

  test("gates an MCP tool when its rule key matches", async () => {
    const h = harness({
      create: [pendingCreate],
      rules: ["github/create_issue"],
      serverKeys: ["github"],
      wait: [finished(ALLOW_ONCE)],
    });

    const verdict = await h.gate.decide({
      input: { title: "Bug" },
      name: "mcp__github__create_issue",
      toolUseId: TOOL_USE_ID,
    });

    expect(verdict).toEqual({ kind: "allow" });
    expect(h.creates[0]?.body.display).toMatchObject({
      toolKey: "github/create_issue",
      toolName: "mcp__github__create_issue",
    });
  });

  test("leaves an MCP tool alone when no rule names it", async () => {
    const h = harness({ rules: [], serverKeys: ["github"] });

    const verdict = await h.gate.decide({
      input: { title: "Bug" },
      name: "mcp__github__create_issue",
      toolUseId: TOOL_USE_ID,
    });

    expect(verdict).toBeUndefined();
    expect(h.creates).toHaveLength(0);
  });

  test("routes AskUserQuestion as a question even with no rules", async () => {
    const h = harness({
      create: [pendingCreate],
      rules: [],
      wait: [
        finished({
          answer: { answers: { "Which color?": "Blue" } },
          status: "answered",
        }),
      ],
    });

    const verdict = await h.gate.decide(questionCall());

    expect(h.creates[0]?.body).toEqual({
      display: {
        questions: [
          {
            choices: ["Red", "Blue"],
            header: "Color",
            multiSelect: false,
            question: "Which color?",
          },
        ],
      },
      kind: "question",
      toolName: "AskUserQuestion",
      toolUseId: TOOL_USE_ID,
    });
    expect(verdict).toEqual({
      kind: "allow",
      updatedInput: {
        ...QUESTION_INPUT,
        answers: { "Which color?": "Blue" },
      },
    });
  });

  test("drops an answer for a question that was not asked", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [
        finished({
          answer: {
            answers: { "Not asked?": "yes", "Which color?": "Blue" },
          },
          status: "answered",
        }),
      ],
    });

    const verdict = await h.gate.decide(questionCall());

    expect(verdict).toEqual({
      kind: "allow",
      updatedInput: {
        ...QUESTION_INPUT,
        answers: { "Which color?": "Blue" },
      },
    });
  });

  test("denies an expired question with the question text", async () => {
    const expired: RequestOutcome = { status: "expired" };
    const h = harness({
      create: [pendingCreate],
      wait: [finished(expired)],
    });

    const verdict = await h.gate.decide(questionCall());

    expect(verdict).toEqual({
      kind: "deny",
      reason: denialText("question", expired),
    });
  });

  test("denies an AskUserQuestion input with no questions without calling the API", async () => {
    const h = harness({});

    const verdict = await h.gate.decide(questionCall({}));

    expect(reasonOf(verdict)).toContain("AskUserQuestion needs");
    expect(h.creates).toHaveLength(0);
  });

  test("ends the wait when the run's signal aborts", async () => {
    const h = harness({ create: [pendingCreate], hangWait: true });

    const verdict = h.gate.decide(bashCall());
    await h.waiting;
    h.run.abort();

    expect(reasonOf(await verdict)).toContain("run is ending");
  });

  test("ends the wait when the call's own signal aborts", async () => {
    const h = harness({ create: [pendingCreate], hangWait: true });
    const controller = new AbortController();

    const verdict = h.gate.decide({ ...bashCall(), signal: controller.signal });
    await h.waiting;
    controller.abort();

    expect(reasonOf(await verdict)).toContain("run is ending");
    expect(h.run.signal.aborted).toBe(false);
  });

  for (const status of [NO_ANSWER, UNAVAILABLE]) {
    test(`retries a transient createRequest failure with status ${status} after one backoff`, async () => {
      const h = harness({
        create: [new RunApiError("x", status), pendingCreate],
        wait: [finished(ALLOW_ONCE)],
      });

      const verdict = await h.gate.decide(bashCall());

      expect(verdict).toEqual({ kind: "allow" });
      expect(h.creates).toHaveLength(2);
      expect(h.delays).toEqual([nextBackoffMs(0, random)]);
    });
  }

  test("retries a transient waitRequest failure and keeps the same request", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [new RunApiError("x", UNAVAILABLE), finished(ALLOW_ONCE)],
    });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({ kind: "allow" });
    expect(h.creates).toHaveLength(1);
    expect(h.waits.map((wait) => wait.requestId)).toEqual([
      REQUEST_ID,
      REQUEST_ID,
    ]);
    expect(h.delays).toEqual([nextBackoffMs(0, random)]);
  });

  for (const status of [CONFLICT, FORBIDDEN]) {
    test(`denies without a retry when the platform answers ${status}`, async () => {
      const h = harness({
        create: [new RunApiError("x", status)],
      });

      const verdict = await h.gate.decide(bashCall());

      expect(verdict).toEqual({ kind: "deny", reason: PLATFORM_REFUSED });
      expect(h.creates).toHaveLength(1);
      expect(h.delays).toHaveLength(0);
    });
  }

  test("truncates a tool input over the route's byte limit", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [finished(ALLOW_ONCE)],
    });

    await h.gate.decide(bashCall("x".repeat(OVERSIZE_COMMAND_CHARS)));

    const display = h.creates[0]?.body.display;
    expect(display).toHaveProperty("input", expect.any(String));
    const text = String((display as { input: string }).input);
    expect(text.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    expect(encoder.encode(text).byteLength).toBeLessThan(INPUT_MAX_BYTES);
  });

  test("the body for an input over the limit passes the route's schemas", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [finished(ALLOW_ONCE)],
    });

    await h.gate.decide(bashCall("x".repeat(OVERSIZE_COMMAND_CHARS)));

    const body = h.creates[0]?.body;
    const parsed = createRequestBodySchema.parse(body);
    if (!("input" in parsed.display)) {
      throw new Error("expected an approval display");
    }
    // The route wraps the text preview as `{ preview }` before it calls `open`.
    expect(
      openInputSchema.safeParse({
        input: { preview: parsed.display.input },
        kind: "approval",
        runId: "run_1",
        toolName: parsed.toolName,
        toolUseId: parsed.toolUseId,
      }).success
    ).toBe(true);
  });
});

describe("gateOptions", () => {
  const hookInput = (command: string): PreToolUseHookInput => ({
    cwd: "/",
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_input: { command },
    tool_name: "Bash",
    tool_use_id: TOOL_USE_ID,
    transcript_path: "",
  });

  test("allows a tool call through canUseTool with the same input", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [finished(ALLOW_ONCE)],
    });
    const { canUseTool } = gateOptions(h.gate);
    const input = { command: "ls" };

    const result = await canUseTool?.("Bash", input, {
      signal: new AbortController().signal,
    } as Parameters<NonNullable<typeof canUseTool>>[2]);

    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  test("sets the PreToolUse hook timeout to the hook timeout", () => {
    const h = harness({});

    const matcher = gateOptions(h.gate).hooks?.PreToolUse?.[0];

    expect(matcher?.timeout).toBe(HOOK_TIMEOUT_SECONDS);
  });

  test("answers an unruled call with an empty hook output", async () => {
    const h = harness({ rules: [] });
    const hook = gateOptions(h.gate).hooks?.PreToolUse?.[0]?.hooks[0];

    const output = await hook?.(hookInput("ls"), TOOL_USE_ID, {
      signal: new AbortController().signal,
    });

    expect(output).toEqual({});
  });

  test("allows a ruled call through the PreToolUse hook", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [finished(ALLOW_ONCE)],
    });
    const hook = gateOptions(h.gate).hooks?.PreToolUse?.[0]?.hooks[0];

    const output = await hook?.(hookInput("ls"), TOOL_USE_ID, {
      signal: new AbortController().signal,
    });

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  test("denies a ruled call through the PreToolUse hook with the reason", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [
        finished({
          answer: { decision: "deny", note: "too risky" },
          status: "answered",
        }),
      ],
    });
    const hook = gateOptions(h.gate).hooks?.PreToolUse?.[0]?.hooks[0];

    const output = await hook?.(hookInput("rm -rf /"), TOOL_USE_ID, {
      signal: new AbortController().signal,
    });

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "A person denied this call. too risky",
      },
    });
  });
});

describe("createApprovalGate.decide, limits and later calls", () => {
  test("denies after MAX_RETRIES failed attempts in a row", async () => {
    const h = harness({
      create: Array.from(
        { length: MAX_RETRIES + 1 },
        () => new RunApiError("x", UNAVAILABLE)
      ),
    });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({ kind: "deny", reason: PLATFORM_REFUSED });
    expect(h.creates).toHaveLength(MAX_RETRIES + 1);
    expect(h.delays).toHaveLength(MAX_RETRIES);
    expect(h.delays).toEqual(
      Array.from({ length: MAX_RETRIES }, (_, attempt) =>
        nextBackoffMs(attempt, random)
      )
    );
  });

  test("denies at once when the answer cannot be read", async () => {
    const h = harness({ create: [new RunApiError("x", UNREADABLE_ANSWER)] });

    const verdict = await h.gate.decide(bashCall());

    expect(verdict).toEqual({ kind: "deny", reason: PLATFORM_REFUSED });
    expect(h.delays).toHaveLength(0);
  });

  test("always_allow lets the same tool run unasked for the rest of the run", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [
        finished({
          answer: { decision: "always_allow" },
          status: "answered",
        }),
      ],
    });

    expect(await h.gate.decide(bashCall())).toEqual({ kind: "allow" });
    expect(await h.gate.decide(bashCall("pwd"))).toBeUndefined();
    expect(h.creates).toHaveLength(1);
  });

  test("allow_once asks again for the next call", async () => {
    const h = harness({
      create: [pendingCreate, pendingCreate],
      wait: [finished(ALLOW_ONCE), finished(ALLOW_ONCE)],
    });

    await h.gate.decide(bashCall());
    await h.gate.decide(bashCall("pwd"));

    expect(h.creates).toHaveLength(2);
  });

  test("a question answered with an approval answer is denied", async () => {
    const h = harness({
      create: [pendingCreate],
      wait: [finished(ALLOW_ONCE)],
    });

    const verdict = await h.gate.decide(questionCall());

    expect(verdict).toEqual({ kind: "deny", reason: PLATFORM_REFUSED });
  });

  test("the bodies it sends satisfy the request protocol", async () => {
    const h = harness({
      create: [pendingCreate, pendingCreate],
      rules: ["bash"],
      wait: [finished(ALLOW_ONCE), finished(ALLOW_ONCE)],
    });

    await h.gate.decide(bashCall());
    await h.gate.decide(
      questionCall({
        questions: [
          {
            header: "",
            options: [{ label: "" }, { label: "Red" }],
            question: "Which?",
          },
        ],
      })
    );

    expect(h.creates).toHaveLength(2);
    for (const { body } of h.creates) {
      expect(createRequestBodySchema.safeParse(body).success).toBe(true);
    }
    expect(h.creates[1]?.body.display).toEqual({
      questions: [{ choices: ["Red"], question: "Which?" }],
    });
  });

  test("an MCP call is summarised by its rule key", async () => {
    const h = harness({
      create: [pendingCreate],
      rules: ["github/create_issue"],
      serverKeys: ["github"],
      wait: [finished(ALLOW_ONCE)],
    });

    await h.gate.decide({
      input: { title: "x" },
      name: "mcp__github__create_issue",
      toolUseId: TOOL_USE_ID,
    });

    expect(h.creates[0]?.body.display).toMatchObject({
      summary: "Call github/create_issue",
    });
  });
});
