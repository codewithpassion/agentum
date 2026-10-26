// Gates a machine run's tool calls through the platform.
//
// Spike finding (V1.12, Agent SDK 0.2.119 with the real `claude` 2.1.310,
// permissionMode "bypassPermissions", scripts in tmp/V1.12/):
//   1. A PreToolUse hook that awaits 70 s inside a matcher with `timeout: 300`
//      still decides the call, both allow and deny.
//   2. `permissionDecision: "deny"` with a reason reaches the model, which
//      quotes the reason back ("PreToolUse:Bash hook error: <reason>").
//   3. AskUserQuestion is NOT offered to the model unless the query has a
//      `canUseTool` callback. With one set, the tool shows up, the hook runs
//      first, and `updatedInput` with an `answers` map plus `allow` returns
//      those answers to the model. `canUseTool` is never called for the call
//      the hook decided, and the mode can stay bypassPermissions.
// So the mechanism is the hook, plus a `canUseTool` that allows at once and
// exists only so the SDK offers AskUserQuestion.
//
// The hook fails closed: whatever goes wrong while a ruled call waits, the
// call is denied with a reason, because a hook that throws lets the tool run.

import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { CreateRequestBody } from "@repo/protocol/machine";
import {
  type ApprovalDisplay,
  approvalSummary,
  askUserQuestionAnswers,
  isAskUserCall,
  outcomeText,
  type Question,
  questionDisplaySchema,
  type RequestOutcome,
  toolKey,
} from "@repo/protocol/requests";
import { nextBackoffMs } from "./backoff.ts";
import type { RunApi } from "./run-api.ts";

/** The hook may wait as long as the longest request lives (a question, 24 h), plus an hour. Seconds. */
export const HOOK_TIMEOUT_SECONDS = 25 * 60 * 60;

/** The approval route refuses a tool input over this many UTF-8 bytes. */
const INPUT_MAX_BYTES = 8192;
const INPUT_PREVIEW_CHARS = 1300;
const SERVER_ERROR = 500;
/** Statuses that clear up by themselves: no answer, request timeout, rate limit and a server fault. */
const RETRYABLE_STATUSES = new Set([0, 408, 429]);

const encoder = new TextEncoder();

const REASONS = {
  aborted: "The run is ending, so the call did not run.",
  invalidQuestion:
    "AskUserQuestion needs one to four questions, each with its text. Ask again with that shape.",
  unavailable:
    "The platform could not take this request, so the call did not run.",
} as const;

export type Verdict =
  | { kind: "allow"; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; reason: string };

export interface ToolCall {
  input: unknown;
  name: string;
  /** Ends the wait for this call alone. The gate's own signal ends every wait. */
  signal?: AbortSignal;
  toolUseId: string;
}

export interface ApprovalGate {
  /** Undefined when the call needs no one: no ask rule and not AskUserQuestion. Never rejects. */
  decide: (call: ToolCall) => Promise<Verdict | undefined>;
}

export interface ApprovalGateOptions {
  api: Pick<RunApi, "createRequest" | "waitRequest">;
  log: (message: string) => void;
  random?: () => number;
  /** The claim's `toolRules`: tool keys that wait for a person. */
  rules: readonly string[];
  /** The claim's MCP server names, to split `mcp__<server>__<tool>` into a rule key. */
  serverKeys: readonly string[];
  /** The run's abort signal. */
  signal: AbortSignal;
  /** Resolves after `ms`, rejects when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal.reason);
    };
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const statusOf = (error: unknown): number | undefined =>
  isRecord(error) && typeof error.status === "number"
    ? error.status
    : undefined;

const isTransient = (error: unknown): boolean => {
  const status = statusOf(error);
  return (
    status !== undefined &&
    (RETRYABLE_STATUSES.has(status) || status >= SERVER_ERROR)
  );
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The tool input as the request route accepts it: JSON under its byte limit, else a text preview. */
const displayInput = (input: unknown): ApprovalDisplay["input"] => {
  const json = JSON.stringify(input ?? {});
  return encoder.encode(json).byteLength <= INPUT_MAX_BYTES
    ? (JSON.parse(json) as never)
    : `${json.slice(0, INPUT_PREVIEW_CHARS)}… [truncated]`;
};

/** AskUserQuestion's questions as the platform shows them: its option labels become choices. */
const questionsOf = (input: unknown): Question[] | undefined => {
  if (!(isRecord(input) && Array.isArray(input.questions))) {
    return;
  }
  const questions = input.questions.map((item: unknown): unknown => {
    if (!isRecord(item)) {
      return item;
    }
    const choices = Array.isArray(item.options)
      ? item.options.flatMap((option: unknown) =>
          isRecord(option) && typeof option.label === "string"
            ? [option.label]
            : []
        )
      : [];
    return {
      question: item.question,
      ...(choices.length > 0 ? { choices } : {}),
      ...(typeof item.header === "string" && item.header !== ""
        ? { header: item.header }
        : {}),
      ...(typeof item.multiSelect === "boolean"
        ? { multiSelect: item.multiSelect }
        : {}),
    };
  });
  const parsed = questionDisplaySchema.safeParse({ questions });
  return parsed.success ? parsed.data.questions : undefined;
};

export const createApprovalGate = (
  options: ApprovalGateOptions
): ApprovalGate => {
  const { api, log, rules, serverKeys } = options;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepUnlessAborted;

  /** Runs one API call, again after a backoff while it fails in a way that clears up. Throws the rest. */
  const retrying = async <T>(
    label: string,
    signal: AbortSignal,
    step: () => Promise<T>
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a retry waits for the attempt before it.
        return await step();
      } catch (error) {
        if (signal.aborted || !isTransient(error)) {
          throw error;
        }
        log(`${label} will retry: ${messageOf(error)}`);
        await sleep(nextBackoffMs(attempt, random), signal);
      }
    }
  };

  /** Raises the request, then polls until it has an outcome. */
  const outcomeOf = async (
    body: CreateRequestBody,
    signal: AbortSignal
  ): Promise<RequestOutcome> => {
    const opened = await retrying(`request ${body.toolName}`, signal, () =>
      api.createRequest(body, signal)
    );
    let { outcome } = opened;
    while (outcome === undefined) {
      // biome-ignore lint/performance/noAwaitInLoops: each poll follows the one before it.
      const waited = await retrying(`wait ${body.toolName}`, signal, () =>
        api.waitRequest(opened.requestId, signal)
      );
      ({ outcome } = waited);
    }
    return outcome;
  };

  const approval = async (
    call: ToolCall,
    key: string,
    signal: AbortSignal
  ): Promise<Verdict> => {
    const outcome = await outcomeOf(
      {
        display: {
          input: displayInput(call.input),
          summary: approvalSummary(call.name, call.input),
          toolKey: key,
          toolName: call.name,
        },
        kind: "approval",
        toolName: call.name,
        toolUseId: call.toolUseId,
      },
      signal
    );
    const reason = outcomeText("approval", outcome);
    return reason === null ? { kind: "allow" } : { kind: "deny", reason };
  };

  const question = async (
    call: ToolCall,
    questions: Question[],
    signal: AbortSignal
  ): Promise<Verdict> => {
    const outcome = await outcomeOf(
      {
        display: { questions },
        kind: "question",
        toolName: call.name,
        toolUseId: call.toolUseId,
      },
      signal
    );
    if (outcome.status !== "answered" || !("answers" in outcome.answer)) {
      return {
        kind: "deny",
        reason: outcomeText("question", outcome) ?? REASONS.unavailable,
      };
    }
    const answers = askUserQuestionAnswers(call.input, outcome.answer);
    return {
      kind: "allow",
      updatedInput: { ...(isRecord(call.input) ? call.input : {}), answers },
    };
  };

  const decide = async (call: ToolCall): Promise<Verdict | undefined> => {
    const asks = isAskUserCall("machine", call.name);
    const key = toolKey({ name: call.name, runtime: "machine", serverKeys });
    if (!(asks || rules.includes(key))) {
      return;
    }
    const signal =
      call.signal === undefined
        ? options.signal
        : AbortSignal.any([options.signal, call.signal]);
    try {
      if (!asks) {
        return await approval(call, key, signal);
      }
      const questions = questionsOf(call.input);
      return questions === undefined
        ? { kind: "deny", reason: REASONS.invalidQuestion }
        : await question(call, questions, signal);
    } catch (error) {
      if (signal.aborted) {
        return { kind: "deny", reason: REASONS.aborted };
      }
      log(`request ${call.name} failed: ${messageOf(error)}`);
      return { kind: "deny", reason: REASONS.unavailable };
    }
  };

  return { decide };
};

const preToolUse =
  (gate: ApprovalGate): HookCallback =>
  async (input, _toolUseId, { signal }): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const verdict = await gate.decide({
      input: input.tool_input,
      name: input.tool_name,
      signal,
      toolUseId: input.tool_use_id,
    });
    if (verdict === undefined) {
      return {};
    }
    return {
      hookSpecificOutput:
        verdict.kind === "allow"
          ? {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              ...(verdict.updatedInput === undefined
                ? {}
                : { updatedInput: verdict.updatedInput }),
            }
          : {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: verdict.reason,
            },
    };
  };

// Never reached for a call the hook decided; its presence is what makes the
// SDK offer AskUserQuestion. Allowing matches bypassPermissions.
const allowAtOnce: CanUseTool = (_name, input) =>
  Promise.resolve({ behavior: "allow", updatedInput: input });

/** The Claude Code options that put `gate` in front of every tool call. */
export const gateOptions = (
  gate: ApprovalGate
): Pick<Options, "canUseTool" | "hooks"> => ({
  canUseTool: allowAtOnce,
  hooks: {
    PreToolUse: [{ hooks: [preToolUse(gate)], timeout: HOOK_TIMEOUT_SECONDS }],
  },
});
