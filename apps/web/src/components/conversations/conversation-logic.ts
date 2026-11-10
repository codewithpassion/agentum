import type { RouterOutputs, SessionListItem } from "#/integrations/trpc/types";
import {
  originLabel,
  sessionTitle,
  statusLabel,
} from "../sessions/sessions-logic.ts";

export type ConversationKind = "assistant" | "thread";

/** One row of the shared conversation list, whichever source it came from. */
export interface ConversationListItem {
  activityAt: string;
  /** The agent and origin of a thread. Assistant conversations have none. */
  detail?: string;
  /** Where the row goes when it is a link. A row with none is a button. */
  href?: string;
  id: string;
  kind: ConversationKind;
  title: string;
}

export const KIND_LABELS: Record<ConversationKind, string> = {
  assistant: "Assistant",
  thread: "Thread",
};

export const threadHref = (sessionId: string): string =>
  `/threads/${encodeURIComponent(sessionId)}`;

export const fromAssistant = (
  item: RouterOutputs["assistant"]["list"][number]
): ConversationListItem => ({
  activityAt: item.updatedAt,
  id: item.id,
  kind: "assistant",
  title: item.title,
});

export const fromRow = (
  row: RouterOutputs["conversations"]["list"][number],
  agentNames: ReadonlyMap<string, string>
): ConversationListItem => {
  if (row.kind === "assistant") {
    return {
      activityAt: row.activityAt,
      id: row.id,
      kind: "assistant",
      title: row.title,
    };
  }
  return fromThread(row.thread, agentNames.get(row.thread.agentId) ?? "Agent");
};

export const fromThread = (
  thread: SessionListItem,
  agentName: string
): ConversationListItem => ({
  activityAt: thread.lastRunAt ?? thread.createdAt,
  detail: `${agentName}, ${originLabel(thread)}, ${statusLabel(thread.status)}`,
  href: threadHref(thread.id),
  id: thread.id,
  kind: "thread",
  title: sessionTitle({
    agentName,
    createdAt: thread.createdAt,
    title: thread.title,
  }),
});
