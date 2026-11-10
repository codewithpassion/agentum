import type { SessionListItem } from "#/integrations/trpc/types";

export const ORIGIN_VALUES = [
  "ui",
  "slack",
  "inbox",
  "trigger",
  "routine",
  "mcp",
  "mail",
  "qa",
  "a2a",
  "artifact",
] as const;
export type OriginValue = (typeof ORIGIN_VALUES)[number];

export const ORIGIN_LABELS: Record<OriginValue, string> = {
  a2a: "A2A",
  artifact: "Artifact",
  inbox: "Inbox",
  mail: "Mail",
  mcp: "MCP",
  qa: "Q&A",
  routine: "Routine",
  slack: "Slack",
  trigger: "Trigger",
  ui: "UI",
};

const isOriginValue = (origin: string): origin is OriginValue =>
  ORIGIN_VALUES.some((value) => value === origin);

/** A Slack session reads as a DM or a thread. Unknown origins show as stored. */
export const originLabel = (item: {
  origin: string;
  private: boolean;
}): string => {
  if (item.origin === "slack") {
    return item.private ? "Slack DM" : "Slack thread";
  }
  return isOriginValue(item.origin) ? ORIGIN_LABELS[item.origin] : item.origin;
};

export const statusLabel = (status: SessionListItem["status"]): string => {
  switch (status) {
    case null:
      return "No runs";
    case "queued":
    case "offered":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting for you";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

/** The time of the last run, or the session's creation when it has no run yet. */
export const lastActivity = (item: {
  createdAt: string;
  lastRunAt: string | null;
}): string => item.lastRunAt ?? item.createdAt;

/** Minutes of an ISO timestamp as "yyyy-MM-dd HH:mm", in UTC so server and browser agree. */
const utcMinute = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 16).replace("T", " ");

/** The trimmed first message, or "agent name, creation time (UTC)" when it is empty. */
export const sessionTitle = ({
  title,
  agentName,
  createdAt,
}: {
  title: string;
  agentName: string;
  createdAt: string;
}): string => {
  const trimmed = title.trim();
  if (trimmed !== "") {
    return trimmed;
  }
  return `${agentName}, ${utcMinute(createdAt)} UTC`;
};
