// Maps Claude Agent SDK messages to Agentum run events and result summaries.
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunEventInput, Usage } from "@repo/protocol/machine";
import { z } from "zod";

export interface NormalizedEvent {
  payload: RunEventInput["payload"];
  type: RunEventInput["type"];
}

export interface RunResult {
  /** True for any result subtype other than `success`. */
  isError: boolean;
  sessionId: string;
  /** `result` text on success; on error the joined `errors` or the subtype name. */
  text: string;
  /** True exactly when the result subtype is `error_max_turns`. */
  turnLimitReached: boolean;
  usage: Usage;
}

type Payload = RunEventInput["payload"];
type AssistantBlock = SDKAssistantMessage["message"]["content"][number];
type UserContent = Exclude<SDKUserMessage["message"]["content"], string>;
type UserBlock = UserContent[number];
type ToolResultBlock = Extract<UserBlock, { type: "tool_result" }>;
type ToolResultContent = ToolResultBlock["content"];
type ToolResultItem = Exclude<ToolResultContent, string | undefined>[number];

const LINE_BREAK = "\n";
const jsonObjectSchema = z.record(z.string(), z.json());

const toInputObject = (input: unknown): Payload => {
  const parsed = jsonObjectSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
};

const toolResultItemText = (item: ToolResultItem): string =>
  item.type === "text" ? item.text : `[${item.type}]`;

const toolResultText = (content: ToolResultContent): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map(toolResultItemText).join(LINE_BREAK);
};

const assistantBlockEvents = (block: AssistantBlock): NormalizedEvent[] => {
  if (block.type === "thinking") {
    // Match text blocks: empty means exactly ""; preserve whitespace verbatim.
    return block.thinking === ""
      ? []
      : [{ payload: { text: block.thinking }, type: "message.reasoning" }];
  }
  if (block.type === "text") {
    return block.text === ""
      ? []
      : [{ payload: { text: block.text }, type: "message.assistant" }];
  }
  if (block.type === "tool_use") {
    return [
      {
        payload: {
          input: toInputObject(block.input),
          name: block.name,
          toolUseId: block.id,
        },
        type: "tool.call",
      },
    ];
  }
  return [];
};

const userBlockEvents = (block: UserBlock): NormalizedEvent[] => {
  if (block.type !== "tool_result") {
    return [];
  }
  return [
    {
      payload: {
        ok: !block.is_error,
        output: toolResultText(block.content),
        toolUseId: block.tool_use_id,
      },
      type: "tool.result",
    },
  ];
};

const assistantEvents = (message: SDKAssistantMessage): NormalizedEvent[] =>
  message.message.content.flatMap(assistantBlockEvents);

const userEvents = (message: SDKUserMessage): NormalizedEvent[] => {
  const { content } = message.message;
  // A plain string is the daemon's own prompt echo, which yields no events.
  return typeof content === "string" ? [] : content.flatMap(userBlockEvents);
};

/** Zero or more events for one SDK message, in block order. */
export const normalizeMessage = (message: SDKMessage): NormalizedEvent[] => {
  if (message.type === "assistant") {
    return assistantEvents(message);
  }
  if (message.type === "user") {
    return userEvents(message);
  }
  return [];
};

/** The session id from a system `init` message, else undefined. */
export const sessionIdOf = (message: SDKMessage): string | undefined =>
  message.type === "system" && message.subtype === "init"
    ? message.session_id
    : undefined;

const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const usageOf = (message: SDKResultMessage): Usage => {
  const usage: Usage = {};
  const costUsd = countOf(message.total_cost_usd);
  const inputTokens = countOf(message.usage?.input_tokens);
  const outputTokens = countOf(message.usage?.output_tokens);
  if (costUsd !== undefined) {
    usage.costUsd = costUsd;
  }
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  return usage;
};

const resultText = (message: SDKResultMessage): string => {
  if (message.subtype === "success") {
    return message.result;
  }
  return message.errors.length > 0
    ? message.errors.join(LINE_BREAK)
    : message.subtype;
};

/** The summary of a `result` message, else undefined. */
export const summariseResult = (message: SDKMessage): RunResult | undefined => {
  if (message.type !== "result") {
    return;
  }
  return {
    isError: message.subtype !== "success",
    sessionId: message.session_id,
    text: resultText(message),
    turnLimitReached: message.subtype === "error_max_turns",
    usage: usageOf(message),
  };
};
