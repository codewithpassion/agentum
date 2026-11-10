import { activityCursor, parseActivityCursor } from "./activity-cursor.ts";
import type { AssistantService } from "./assistant/service.ts";
import type { SessionOrigin } from "./runs/types.ts";
import type { SessionsService } from "./sessions.ts";
import { SESSION_LIST_LIMIT, type SessionListItem } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

/** A row of the shared conversation list: an agent thread or an assistant conversation. */
export type ConversationRow =
  | {
      activityAt: string;
      cursor: string;
      id: string;
      kind: "assistant";
      title: string;
    }
  | {
      activityAt: string;
      cursor: string;
      id: string;
      kind: "thread";
      thread: SessionListItem;
      title: string;
    };

export interface ConversationListOptions {
  agentId?: string;
  cursor?: string;
  limit?: number;
  origin?: SessionOrigin;
  query?: string;
  working?: boolean;
}

const newestFirst = (a: ConversationRow, b: ConversationRow): number => {
  if (a.activityAt !== b.activityAt) {
    return a.activityAt < b.activityAt ? 1 : -1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
};

/**
 * The caller's threads and assistant conversations in one list, newest
 * activity first. Both sources order by activity time then id, so merging
 * their pages and cutting at `limit` gives one stable order, and the last row's
 * cursor pages on in both. Assistant conversations belong to no agent and have
 * no origin or runs, so the agent, origin and working filters leave them out.
 */
export const createConversationsService = (deps: {
  assistant: Pick<AssistantService, "list">;
  sessions: Pick<SessionsService, "list">;
}) => ({
  list: async (
    principal: Principal,
    options: ConversationListOptions = {}
  ): Promise<ConversationRow[]> => {
    const limit = Math.min(
      options.limit ?? SESSION_LIST_LIMIT,
      SESSION_LIST_LIMIT
    );
    if (options.cursor !== undefined) {
      parseActivityCursor(options.cursor);
    }
    const withAssistant =
      principal.kind === "user" &&
      principal.via === "session" &&
      options.agentId === undefined &&
      options.origin === undefined &&
      options.working !== true;
    const [threads, conversations] = await Promise.all([
      deps.sessions.list(principal, { ...options, limit }),
      withAssistant
        ? deps.assistant.list(principal, {
            cursor: options.cursor,
            limit,
            query: options.query,
          })
        : [],
    ]);
    const rows: ConversationRow[] = [
      ...threads.map((thread) => {
        const activityAt = thread.lastRunAt ?? thread.createdAt;
        return {
          activityAt,
          cursor: activityCursor(activityAt, thread.id),
          id: thread.id,
          kind: "thread" as const,
          thread,
          title: thread.title,
        };
      }),
      ...conversations.map((conversation) => ({
        activityAt: conversation.updatedAt,
        cursor: conversation.cursor,
        id: conversation.id,
        kind: "assistant" as const,
        title: conversation.title,
      })),
    ];
    return rows.sort(newestFirst).slice(0, limit);
  },
});
export type ConversationsService = ReturnType<
  typeof createConversationsService
>;
