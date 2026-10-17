import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

import type { RunEventInput, Usage } from "@repo/services/runs/types";

type EventDraft = Omit<RunEventInput, "seq">;

const FIRST_SEQ = 1;
const NONE = 0;

const isAssistant = (message: Message): message is AssistantMessage =>
  message.role === "assistant";

const isToolResult = (message: Message): message is ToolResultMessage =>
  message.role === "toolResult";

const messagesOf = (slice: readonly EntryRecord[]): Message[] =>
  slice.flatMap((entry) => entry.model ?? []);

const assistantsOf = (slice: readonly EntryRecord[]): AssistantMessage[] =>
  messagesOf(slice).filter(isAssistant);

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, NONE);

const textOfPart = (part: TextContent | ImageContent): string =>
  part.type === "text" ? part.text : `[${part.type}]`;

const nonEmptyTexts = (message: AssistantMessage): string[] =>
  message.content.flatMap((part) =>
    part.type === "text" && part.text !== "" ? [part.text] : []
  );

const eventOfPart = (
  part: TextContent | ThinkingContent | ToolCall
): EventDraft[] => {
  if (part.type === "text" && part.text !== "") {
    return [{ payload: { text: part.text }, type: "message.assistant" }];
  }
  if (part.type === "toolCall") {
    return [
      {
        payload: {
          input: part.arguments as RunEventInput["payload"],
          name: part.name,
          toolUseId: part.id,
        },
        type: "tool.call",
      },
    ];
  }
  return [];
};

const eventsOf = (message: Message): EventDraft[] => {
  if (isAssistant(message)) {
    return message.content.flatMap(eventOfPart);
  }
  if (isToolResult(message)) {
    return [
      {
        payload: {
          ok: !message.isError,
          output: message.content.map(textOfPart).join("\n"),
          toolUseId: message.toolCallId,
        },
        type: "tool.result",
      },
    ];
  }
  return [];
};

/** The entries from the one whose id is `start`, up to but not including the one whose id is `end`. No `start`, or a `start` not in `entries`: []. A missing or unknown `end` means to the end of `entries`. */
export const sliceRun = (
  entries: readonly EntryRecord[],
  start: string | undefined,
  end?: string
): EntryRecord[] => {
  if (start === undefined) {
    return [];
  }
  const from = entries.findIndex((entry) => String(entry.id) === start);
  if (from === -1) {
    return [];
  }
  const found =
    end === undefined
      ? -1
      : entries.findIndex((entry) => String(entry.id) === end);
  const to = found === -1 ? entries.length : found;
  return entries.slice(from, to);
};

/** Run events for a slice, seq numbered from 1 by position among the events produced, so translating the same slice again gives the same seqs. */
export const toRunEvents = (slice: readonly EntryRecord[]): RunEventInput[] =>
  messagesOf(slice)
    .flatMap(eventsOf)
    .map((event, index) => ({
      payload: event.payload,
      seq: FIRST_SEQ + index,
      type: event.type,
    }));

/** Sum of the slice's assistant messages' usage, or undefined when there is no assistant message. */
export const usageOf = (slice: readonly EntryRecord[]): Usage | undefined => {
  const usages = assistantsOf(slice).map((message) => message.usage);
  if (usages.length === 0) {
    return;
  }
  const cacheReadTokens = sum(usages.map((usage) => usage.cacheRead));
  const cacheWriteTokens = sum(usages.map((usage) => usage.cacheWrite));
  const cacheTokens =
    cacheReadTokens + cacheWriteTokens > NONE
      ? { cacheReadTokens, cacheWriteTokens }
      : {};
  return {
    ...cacheTokens,
    costUsd: sum(usages.map((usage) => usage.cost.total)),
    inputTokens: sum(usages.map((usage) => usage.input)),
    outputTokens: sum(usages.map((usage) => usage.output)),
  };
};

/** The `errorMessage` of the last assistant message in the slice whose stopReason is "error", else undefined. */
export const failureOf = (slice: readonly EntryRecord[]): string | undefined =>
  assistantsOf(slice).findLast((message) => message.stopReason === "error")
    ?.errorMessage;

/** The joined text parts of the last assistant message in the slice that has any text, else "". */
export const finalText = (slice: readonly EntryRecord[]): string =>
  assistantsOf(slice)
    .map(nonEmptyTexts)
    .findLast((texts) => texts.length > NONE)
    ?.join("\n") ?? "";
