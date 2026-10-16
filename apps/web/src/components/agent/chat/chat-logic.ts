import type { RunStatus } from "@repo/db/shared";
import type { SessionTranscript } from "#/integrations/trpc/types";

type Entry = SessionTranscript["entries"][number];
type Run = NonNullable<SessionTranscript["latestRun"]>;

export const POLL_MS = 1500;
export const RETRY_AFTER_MS = 10 * 60 * 1000;

const TOO_LARGE = "(content too large to show)";

export type ChatItem =
  | { id: string; kind: "user" | "assistant"; text: string }
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
        return [{ id: entry.id, kind: "user", text: textOf(entry) }];
      case "message.assistant":
        return [{ id: entry.id, kind: "assistant", text: textOf(entry) }];
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
