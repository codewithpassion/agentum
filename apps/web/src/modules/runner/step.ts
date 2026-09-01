import { truncateText, withTruncationNote } from "#/modules/computer/output";
import type { ChatMessage, ChatModel, ToolCall } from "./chat";
import type { ToolResult, ToolRunner } from "./tools";

/**
 * One step of the agent loop, written against a transcript store so the Durable
 * Object stays a thin host and the loop itself runs in a unit test.
 *
 * The transcript is the state machine: what the last message is decides what
 * happens next. An assistant turn with tool calls means "run the tools"; an
 * assistant turn without them means "the turn is over, unless somebody wrote
 * in meanwhile"; anything else means "ask the model". That is what makes a
 * step resumable - a host that died halfway picks up from whatever it managed
 * to persist.
 */

export interface RunStore {
  appendMessage: (message: ChatMessage) => Promise<void>;
  clearPartialResults: () => Promise<void>;
  isCancelled: () => Promise<boolean>;
  messages: () => Promise<ChatMessage[]>;
  /** Tool results already computed for the current assistant turn, by call id. */
  partialResults: () => Promise<Record<string, ToolResult>>;
  savePartialResult: (callId: string, result: ToolResult) => Promise<void>;
  /** Messages sent into the run while it was busy, removed as they are taken. */
  takePending: () => Promise<string[]>;
}

export interface StepDeps {
  /** Text the model produced, for the session's event stream. */
  emitText: (text: string) => Promise<void>;
  maxTokens: number;
  model: ChatModel;
  modelId: string;
  system: string;
  tools: ToolRunner;
}

export type StepOutcome =
  | { kind: "cancelled" }
  | { kind: "continue"; calledModel: boolean }
  | { kind: "idle" };

/**
 * What one tool may hand back into the transcript. Most tools cap their own
 * output, but a channel read or a wiki page can be far larger than any model's
 * context - and than the Durable Object's per-value limit.
 */
export const TOOL_RESULT_MAX_BYTES = 96_000;

const toolContent = (result: ToolResult): string => {
  const text = withTruncationNote(
    truncateText(result.text, TOOL_RESULT_MAX_BYTES)
  );
  return result.isError ? `Error: ${text}` : text;
};

const runTool = async (
  tools: ToolRunner,
  call: ToolCall
): Promise<ToolResult> => {
  try {
    return await tools.call(call.name, call.arguments);
  } catch (error) {
    return {
      isError: true,
      text: error instanceof Error ? error.message : String(error),
    };
  }
};

const appendPending = async (store: RunStore): Promise<boolean> => {
  const pending = await store.takePending();
  if (pending.length === 0) {
    return false;
  }
  await store.appendMessage({ content: pending.join("\n\n"), role: "user" });
  return true;
};

const runToolCalls = async (
  store: RunStore,
  deps: StepDeps,
  calls: readonly ToolCall[]
): Promise<void> => {
  const done = await store.partialResults();
  for (const call of calls) {
    if (done[call.id]) {
      continue;
    }
    // In order, persisted one at a time: a host that dies mid-turn re-runs
    // only the calls it never finished, not the message it already posted.
    // biome-ignore lint/performance/noAwaitInLoops: tool calls run in the order the model made them
    const result = await runTool(deps.tools, call);
    await store.savePartialResult(call.id, result);
    done[call.id] = result;
  }
  for (const call of calls) {
    // biome-ignore lint/performance/noAwaitInLoops: results are appended in call order
    await store.appendMessage({
      content: toolContent(
        done[call.id] ?? { isError: true, text: "The tool produced no result." }
      ),
      name: call.name,
      role: "tool",
      toolCallId: call.id,
    });
  }
  await store.clearPartialResults();
};

export const step = async (
  store: RunStore,
  deps: StepDeps
): Promise<StepOutcome> => {
  if (await store.isCancelled()) {
    return { kind: "cancelled" };
  }
  const messages = await store.messages();
  const last = messages.at(-1);
  if (!last) {
    return { kind: "idle" };
  }

  if (last.role === "assistant" && last.toolCalls.length > 0) {
    await runToolCalls(store, deps, last.toolCalls);
    await appendPending(store);
    return { calledModel: false, kind: "continue" };
  }

  if (last.role === "assistant") {
    // The model ended its turn. Anything that arrived meanwhile starts the
    // next one; otherwise the run goes idle until the router sends into it.
    return (await appendPending(store))
      ? { calledModel: false, kind: "continue" }
      : { kind: "idle" };
  }

  const completion = await deps.model.complete({
    maxTokens: deps.maxTokens,
    messages,
    model: deps.modelId,
    system: deps.system,
    tools: deps.tools.definitions(),
  });
  await store.appendMessage({
    content: completion.text,
    role: "assistant",
    toolCalls: completion.toolCalls,
  });
  if (completion.text.trim().length > 0) {
    await deps.emitText(completion.text);
  }
  return { calledModel: true, kind: "continue" };
};
