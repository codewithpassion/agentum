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
  /** The thread this one was started from, when it was started by a hand-off or helper. */
  parentId?: string;
  title: string;
}

/** The deepest indent: a hand-off of a hand-off shows one level in, and so do the ones below it. */
const MAX_INDENT = 2;

/**
 * The rows with each child thread moved under its parent, a level deeper each
 * time, to `MAX_INDENT`. A child whose parent is not in the list stays where it
 * was, at depth 0.
 */
export const nestChildren = <
  T extends Pick<ConversationListItem, "id" | "kind" | "parentId">,
>(
  items: readonly T[]
): { depth: number; item: T }[] => {
  const ids = new Set(items.map((item) => item.id));
  const nested = (item: T) =>
    item.kind === "thread" &&
    item.parentId !== undefined &&
    item.parentId !== item.id &&
    ids.has(item.parentId);
  const children = new Map<string, T[]>();
  for (const item of items.filter(nested)) {
    const siblings = children.get(item.parentId as string) ?? [];
    siblings.push(item);
    children.set(item.parentId as string, siblings);
  }
  const seen = new Set<string>();
  const walk = (item: T, depth: number): { depth: number; item: T }[] => {
    seen.add(item.id);
    return [
      { depth, item },
      ...(children.get(item.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .flatMap((child) => walk(child, Math.min(depth + 1, MAX_INDENT))),
    ];
  };
  return items.filter((item) => !nested(item)).flatMap((item) => walk(item, 0));
};

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
  ...(thread.parentSessionId === null
    ? {}
    : { parentId: thread.parentSessionId }),
  title: sessionTitle({
    agentName,
    createdAt: thread.createdAt,
    title: thread.title,
  }),
});
