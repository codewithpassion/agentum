import { INPUT_FILES_MAX, type RunStatus } from "@repo/db/shared";
import type { SessionTranscript } from "#/integrations/trpc/types";

type Entry = SessionTranscript["entries"][number];
type Run = NonNullable<SessionTranscript["latestRun"]>;

export const POLL_MS = 1500;
export const RETRY_AFTER_MS = 10 * 60 * 1000;

/** What the composer allows: the limit `startRun` enforces. */
export const MAX_ATTACHMENTS = INPUT_FILES_MAX;

const TOO_LARGE = "(content too large to show)";

export type ChatItem =
  | { fileIds: string[]; id: string; kind: "user" | "assistant"; text: string }
  | { detail: string; id: string; kind: "tool"; label: string };

export const isRunActive = (status: RunStatus): boolean =>
  status === "queued" || status === "offered" || status === "running";

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

export const statusLine = (run: Run | null): string | null => {
  if (run === null) {
    return null;
  }
  switch (run.status) {
    case "queued":
    case "offered":
      return "Queued, waiting for the machine";
    case "running":
      return "Running";
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

export const toChatItems = (entries: Entry[]): ChatItem[] =>
  entries.flatMap((entry): ChatItem[] => {
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
      case "message.assistant":
        return [
          { fileIds: [], id: entry.id, kind: "assistant", text: textOf(entry) },
        ];
      case "tool.call":
      case "tool.result":
        return [
          {
            detail: toolDetail(entry),
            id: entry.id,
            kind: "tool",
            label: toolLabel(entry),
          },
        ];
      default:
        return [];
    }
  });

/** The files a run's user message carried, so Retry can send them again. */
export const fileIdsOfRun = (entries: Entry[], runId: string): string[] => {
  const entry = entries.find(
    (candidate) =>
      candidate.type === "message.user" && candidate.runId === runId
  );
  return entry ? fileIdsOf(entry) : [];
};

/** Every file id the chat shows, in first-seen order, without repeats. */
export const collectFileIds = (
  items: ChatItem[],
  outputFileIds: readonly string[]
): string[] => {
  const ids = [
    ...items.flatMap((item) => (item.kind === "tool" ? [] : item.fileIds)),
    ...outputFileIds,
  ];
  return [...new Set(ids)];
};
