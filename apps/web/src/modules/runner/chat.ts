/**
 * The chat shapes the runner's loop is written against, and the translation
 * to and from what the `AI` binding speaks.
 *
 * Requests go out in the OpenAI chat-completions dialect, which every model
 * behind the binding accepts. Responses come back in one of three dialects
 * depending on the model - chat completions (`choices`), the older Workers AI
 * text-generation shape (`response` + `tool_calls`), or Anthropic's
 * (`content` blocks) for a Claude model behind AI Gateway - so the parser
 * recognises all three rather than betting on one.
 */

export interface ToolDefinition {
  description: string;
  name: string;
  /** JSON Schema for the arguments, as the MCP server declares it. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
}

export type ChatMessage =
  | { content: string; role: "user" }
  | { content: string; role: "assistant"; toolCalls: ToolCall[] }
  | { content: string; name: string; role: "tool"; toolCallId: string };

export type FinishReason = "length" | "stop" | "tool_calls" | "unknown";

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatCompletion {
  finishReason: FinishReason;
  text: string;
  toolCalls: ToolCall[];
  usage: ChatUsage | null;
}

export interface ChatRequest {
  maxTokens: number;
  messages: readonly ChatMessage[];
  model: string;
  system: string;
  tools: readonly ToolDefinition[];
}

/** One model call. Implementations throw on transport or provider failure. */
export interface ChatModel {
  complete: (request: ChatRequest) => Promise<ChatCompletion>;
}

// --- outbound ----------------------------------------------------------------

export interface WireRequest {
  max_tokens: number;
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
}

const toWireMessage = (message: ChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      content: message.content,
      name: message.name,
      role: "tool",
      tool_call_id: message.toolCallId,
    };
  }
  if (message.role === "assistant") {
    return {
      // Always a string, never null: the older Workers AI chat templates
      // expect text here even when the turn was only tool calls.
      content: message.content,
      role: "assistant",
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              function: {
                arguments: JSON.stringify(call.arguments),
                name: call.name,
              },
              id: call.id,
              type: "function",
            })),
          }
        : {}),
    };
  }
  return { content: message.content, role: "user" };
};

export const toWireRequest = (request: ChatRequest): WireRequest => ({
  max_tokens: request.maxTokens,
  messages: [
    { content: request.system, role: "system" },
    ...request.messages.map(toWireMessage),
  ],
  ...(request.tools.length > 0
    ? {
        tools: request.tools.map((tool) => ({
          function: {
            description: tool.description,
            name: tool.name,
            parameters: tool.parameters,
          },
          type: "function",
        })),
      }
    : {}),
});

// --- inbound -----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

const numberOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Arguments arrive as a JSON string (chat completions) or an object (the
 * older shape, Anthropic). Unparseable text becomes an empty object: the tool
 * then rejects the missing fields with a message the model can act on, which
 * beats failing the whole turn on one malformed call.
 */
const argumentsOf = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const usageOf = (value: unknown): ChatUsage | null => {
  if (!isRecord(value)) {
    return null;
  }
  const input = value.prompt_tokens ?? value.input_tokens;
  const output = value.completion_tokens ?? value.output_tokens;
  if (input === undefined && output === undefined) {
    return null;
  }
  return { inputTokens: numberOf(input), outputTokens: numberOf(output) };
};

/** A model that names no call id gets one; the transcript needs it to pair results. */
const callId = (given: unknown, index: number): string =>
  typeof given === "string" && given.length > 0 ? given : `call_${index}`;

const toolCallsOf = (value: unknown): ToolCall[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: ToolCall[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    // Chat completions nest name and arguments under `function`; the older
    // Workers AI shape puts them on the call itself.
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = stringOf(fn.name);
    if (!name) {
      continue;
    }
    calls.push({
      arguments: argumentsOf(fn.arguments),
      id: callId(entry.id, index),
      name,
    });
  }
  return calls;
};

const finishReasonOf = (
  value: unknown,
  toolCalls: readonly ToolCall[]
): FinishReason => {
  if (toolCalls.length > 0) {
    return "tool_calls";
  }
  switch (value) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return "tool_calls";
    default:
      return "unknown";
  }
};

const parseChatCompletions = (raw: Record<string, unknown>): ChatCompletion => {
  const [choice] = Array.isArray(raw.choices) ? raw.choices : [];
  const message =
    isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const toolCalls = toolCallsOf(message.tool_calls);
  return {
    finishReason: finishReasonOf(
      isRecord(choice) ? choice.finish_reason : undefined,
      toolCalls
    ),
    text: stringOf(message.content),
    toolCalls,
    usage: usageOf(raw.usage),
  };
};

const parseAnthropic = (raw: Record<string, unknown>): ChatCompletion => {
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text") {
      text.push(stringOf(block.text));
    } else if (block.type === "tool_use" && stringOf(block.name)) {
      calls.push({
        arguments: argumentsOf(block.input),
        id: callId(block.id, index),
        name: stringOf(block.name),
      });
    }
  }
  return {
    finishReason: finishReasonOf(raw.stop_reason, calls),
    text: text.join(""),
    toolCalls: calls,
    usage: usageOf(raw.usage),
  };
};

const parseLegacy = (raw: Record<string, unknown>): ChatCompletion => {
  const toolCalls = toolCallsOf(raw.tool_calls);
  return {
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    text: stringOf(raw.response),
    toolCalls,
    usage: usageOf(raw.usage),
  };
};

/**
 * Whatever the binding returned, as one completion. Throws only when the
 * payload matches none of the dialects, since carrying on from an empty
 * completion would end the agent's turn in silence.
 */
export const parseCompletion = (raw: unknown): ChatCompletion => {
  if (typeof raw === "string") {
    return { finishReason: "stop", text: raw, toolCalls: [], usage: null };
  }
  if (!isRecord(raw)) {
    throw new Error("The model returned an unrecognised response.");
  }
  if (Array.isArray(raw.choices)) {
    return parseChatCompletions(raw);
  }
  if (Array.isArray(raw.content)) {
    return parseAnthropic(raw);
  }
  if ("response" in raw || "tool_calls" in raw) {
    return parseLegacy(raw);
  }
  throw new Error(
    `The model returned an unrecognised response (keys: ${Object.keys(raw).join(", ") || "none"}).`
  );
};
