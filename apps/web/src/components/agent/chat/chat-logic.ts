import { INPUT_FILES_MAX, type RunStatus } from "@repo/db/shared";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import type { SessionTranscript } from "#/integrations/trpc/types";

/** The part of a stored event the chat reads, so a streamed event fits too. */
export type ChatEntry = Pick<
  SessionTranscript["entries"][number],
  "id" | "payload" | "payloadRef" | "runId" | "type"
>;
type Entry = ChatEntry;
type Run = NonNullable<SessionTranscript["latestRun"]>;

export const POLL_MS = 1500;
export const RETRY_AFTER_MS = 10 * 60 * 1000;

/** What the composer allows: the limit `startRun` enforces. */
export const MAX_ATTACHMENTS = INPUT_FILES_MAX;

const TOO_LARGE = "(content too large to show)";

export type ChatItem =
  | { fileIds: string[]; id: string; kind: "user" | "assistant"; text: string }
  | {
      detail: string;
      id: string;
      input: string | null;
      kind: "tool";
      label: string;
      output: string | null;
    };

export const isRunActive = (status: RunStatus): boolean =>
  status === "queued" ||
  status === "offered" ||
  status === "running" ||
  status === "waiting";

export const canCancel = (run: Run | null): boolean =>
  run !== null && isRunActive(run.status);

export const canRetry = (run: Run | null, nowMs: number): boolean => {
  if (run?.status !== "interrupted") {
    return false;
  }
  if (run.processEndedAt !== null) {
    return true;
  }
  return nowMs - Date.parse(run.finishedAt ?? run.createdAt) >= RETRY_AFTER_MS;
};

export const shouldPoll = (run: Run | null, nowMs: number): boolean => {
  if (run === null) {
    return false;
  }
  if (isRunActive(run.status)) {
    return true;
  }
  return (
    run.status === "interrupted" &&
    run.processEndedAt === null &&
    !canRetry(run, nowMs)
  );
};

export const statusLine = (
  run: Run | null,
  queue: SessionTranscript["queue"]
): string | null => {
  if (run === null) {
    return null;
  }
  switch (run.status) {
    case "queued":
    case "offered":
      if (queue?.runtime === "cloud" || queue?.runtime === "managed") {
        return queue.otherRunActive
          ? "Queued, waiting for the agent's current run to finish"
          : "Queued";
      }
      return "Queued, waiting for the machine";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting for an answer";
    case "done":
      return "Done";
    case "failed":
      return run.error ? `Failed: ${run.error}` : "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return run.processEndedAt === null
        ? "Interrupted. The process may still be running."
        : "Interrupted";
  }
};

const textOf = (entry: Entry): string => {
  if (entry.payloadRef !== null) {
    return TOO_LARGE;
  }
  const { text } = entry.payload;
  return typeof text === "string" ? text : "";
};

const fileIdsOf = (entry: Entry): string[] => {
  const { fileIds } = entry.payload;
  return Array.isArray(fileIds)
    ? fileIds.filter((id): id is string => typeof id === "string")
    : [];
};

const toolLabel = (entry: Entry): string => {
  const { name, tool } = entry.payload;
  if (typeof name === "string") {
    return name;
  }
  if (typeof tool === "string") {
    return tool;
  }
  return entry.type;
};

const toolDetail = (entry: Entry): string =>
  entry.payloadRef === null
    ? JSON.stringify(entry.payload, null, 2)
    : TOO_LARGE;

const toolInputOf = (entry: Entry): string | null => {
  if (entry.payloadRef !== null) {
    return null;
  }
  const { input } = entry.payload;
  return input === undefined ? null : JSON.stringify(input, null, 2);
};

/** The output of a call's paired result. */
const pairedOutputOf = (entry: Entry): string | null => {
  if (entry.payloadRef !== null) {
    return TOO_LARGE;
  }
  const { output } = entry.payload;
  if (output === undefined) {
    return null;
  }
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
};

/** The output of a result that has no call to pair with. */
const loneOutputOf = (entry: Entry): string | null => {
  if (entry.payloadRef !== null) {
    return null;
  }
  const { output } = entry.payload;
  return typeof output === "string" ? output : null;
};

const toolUseIdOf = (entry: Entry): string | null => {
  const { toolUseId } = entry.payload;
  return typeof toolUseId === "string" ? toolUseId : null;
};

/**
 * Maps the index of each tool call to the index of its result. Calls with the
 * same toolUseId take results in order, and a result pairs with one call only.
 */
const pairToolResults = (entries: Entry[]): Map<number, number> => {
  const openCallsById = new Map<string, number[]>();
  const resultByCall = new Map<number, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "tool.call" && entry.type !== "tool.result") {
      continue;
    }
    const toolUseId = toolUseIdOf(entry);
    if (toolUseId === null) {
      continue;
    }
    if (entry.type === "tool.call") {
      const open = openCallsById.get(toolUseId) ?? [];
      open.push(index);
      openCallsById.set(toolUseId, open);
    } else {
      const callIndex = openCallsById.get(toolUseId)?.shift();
      if (callIndex !== undefined) {
        resultByCall.set(callIndex, index);
      }
    }
  }
  return resultByCall;
};

/** Index of the last assistant message of each run, by run id. */
const lastAssistantIndexByRun = (entries: Entry[]): Map<string, number> => {
  const indexes = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "message.assistant" && entry.runId !== null) {
      indexes.set(entry.runId, index);
    }
  }
  return indexes;
};

/**
 * Output files of runs that have no assistant message, placed after the last
 * entry of their run so they still show up in the chat.
 */
const orphanOutputItemsByIndex = (
  entries: Entry[],
  outputFileIds: Record<string, string[]>,
  assistantIndexes: Map<string, number>
): Map<number, ChatItem> => {
  const lastEntryIndexes = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.runId !== null) {
      lastEntryIndexes.set(entry.runId, index);
    }
  }
  const items = new Map<number, ChatItem>();
  for (const [runId, fileIds] of Object.entries(outputFileIds)) {
    const index = lastEntryIndexes.get(runId);
    if (
      index === undefined ||
      fileIds.length === 0 ||
      assistantIndexes.has(runId)
    ) {
      continue;
    }
    items.set(index, {
      fileIds,
      id: `${runId}-files`,
      kind: "assistant",
      text: "",
    });
  }
  return items;
};

export const toChatItems = (
  entries: Entry[],
  outputFileIds: Record<string, string[]> = {}
): ChatItem[] => {
  const assistantIndexes = lastAssistantIndexByRun(entries);
  const orphanItems = orphanOutputItemsByIndex(
    entries,
    outputFileIds,
    assistantIndexes
  );
  const resultByCall = pairToolResults(entries);
  const pairedResults = new Set(resultByCall.values());
  return entries.flatMap((entry, index): ChatItem[] => {
    const resultIndex = resultByCall.get(index);
    const toolResult =
      resultIndex === undefined ? undefined : entries[resultIndex];
    const items = pairedResults.has(index)
      ? []
      : entryItems(entry, index, assistantIndexes, outputFileIds, toolResult);
    const orphan = orphanItems.get(index);
    return orphan ? [...items, orphan] : items;
  });
};

const entryItems = (
  entry: Entry,
  index: number,
  assistantIndexes: Map<string, number>,
  outputFileIds: Record<string, string[]>,
  toolResult: Entry | undefined
): ChatItem[] => {
  switch (entry.type) {
    case "message.user":
      return [
        {
          fileIds: fileIdsOf(entry),
          id: entry.id,
          kind: "user",
          text: textOf(entry),
        },
      ];
    case "message.assistant": {
      const isLastOfRun =
        entry.runId !== null && assistantIndexes.get(entry.runId) === index;
      const fileIds =
        isLastOfRun && entry.runId !== null
          ? (outputFileIds[entry.runId] ?? [])
          : [];
      return [
        {
          fileIds,
          id: entry.id,
          kind: "assistant",
          text: stripAttachmentMarkers(textOf(entry)),
        },
      ];
    }
    case "tool.call":
      return [
        {
          detail: toolDetail(entry),
          id: entry.id,
          input: toolInputOf(entry),
          kind: "tool",
          label: toolLabel(entry),
          output: toolResult === undefined ? null : pairedOutputOf(toolResult),
        },
      ];
    case "tool.result":
      return [
        {
          detail: toolDetail(entry),
          id: entry.id,
          input: null,
          kind: "tool",
          label: toolLabel(entry),
          output: loneOutputOf(entry),
        },
      ];
    default:
      return [];
  }
};

/** The files a run's user message carried, so Retry can send them again. */
export const fileIdsOfRun = (entries: Entry[], runId: string): string[] => {
  const entry = entries.find(
    (candidate) =>
      candidate.type === "message.user" && candidate.runId === runId
  );
  return entry ? fileIdsOf(entry) : [];
};

/** Every file id the chat shows, in first-seen order, without repeats. */
export const collectFileIds = (items: ChatItem[]): string[] => [
  ...new Set(
    items.flatMap((item) => (item.kind === "tool" ? [] : item.fileIds))
  ),
];
