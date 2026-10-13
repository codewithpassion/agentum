import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import type {
  AnthropicGateway,
  ListedSession,
} from "#/modules/anthropic/gateway";
import {
  type Agent,
  type AgentSession,
  agentSessions,
  type SessionEndReason,
} from "./schema";

/**
 * The agent's past Managed Agents sessions. The router writes a row when it
 * creates a session and closes it when it lets the session go; nothing here
 * touches Anthropic, which keeps the sessions themselves.
 */

export interface SessionStart {
  agentId: string;
  anthropicSessionId: string;
  model?: string | null;
  title?: string | null;
  workspaceId: string;
}

export const recordSessionStart = async (
  db: Db,
  input: SessionStart
): Promise<void> => {
  await db
    .insert(agentSessions)
    .values({
      agentId: input.agentId,
      anthropicSessionId: input.anthropicSessionId,
      id: crypto.randomUUID(),
      model: input.model ?? null,
      title: input.title ?? null,
      workspaceId: input.workspaceId,
    })
    .onConflictDoNothing();
};

/** A no-op for an unknown session, and for one already ended (first reason wins). */
export const recordSessionEnd = async (
  db: Db,
  anthropicSessionId: string,
  reason: SessionEndReason
): Promise<void> => {
  await db
    .update(agentSessions)
    .set({ endedAt: new Date(), endReason: reason })
    .where(
      and(
        eq(agentSessions.anthropicSessionId, anthropicSessionId),
        isNull(agentSessions.endedAt)
      )
    );
};

/** Makes a past session the current one again. */
export const reopenSession = async (
  db: Db,
  anthropicSessionId: string
): Promise<void> => {
  await db
    .update(agentSessions)
    .set({ endedAt: null, endReason: null })
    .where(eq(agentSessions.anthropicSessionId, anthropicSessionId));
};

export const listAgentSessionRows = (
  db: Db,
  workspaceId: string,
  agentId: string,
  limit: number
): Promise<AgentSession[]> =>
  db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.agentId, agentId)
      )
    )
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit);

/** Scoped to the agent: another agent's session id finds nothing. */
export const getAgentSessionRow = async (
  db: Db,
  workspaceId: string,
  agentId: string,
  anthropicSessionId: string
): Promise<AgentSession | undefined> => {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.agentId, agentId),
        eq(agentSessions.anthropicSessionId, anthropicSessionId)
      )
    )
    .limit(1);
  return row;
};

/**
 * Imports the sessions Anthropic already holds for an agent that has no
 * history yet, as ended rows - except the current one, which stays open. Does
 * nothing once the agent has any row, so it runs at most once per agent.
 */
export const backfillAgentSessions = async (
  db: Db,
  agent: { id: string; sessionId: string | null; workspaceId: string },
  listSessions: () => Promise<ListedSession[]>
): Promise<void> => {
  const [existing] = await listAgentSessionRows(
    db,
    agent.workspaceId,
    agent.id,
    1
  );
  if (existing) {
    return;
  }
  for (const session of await listSessions()) {
    const current = session.id === agent.sessionId;
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen rows, once per agent
    await db
      .insert(agentSessions)
      .values({
        agentId: agent.id,
        anthropicSessionId: session.id,
        endedAt: current ? null : new Date(session.updatedAt),
        endReason: current ? null : "imported",
        id: crypto.randomUUID(),
        startedAt: new Date(session.createdAt),
        title: session.title,
        workspaceId: agent.workspaceId,
      })
      .onConflictDoNothing();
  }
};

/**
 * `backfillAgentSessions` for a managed, registered agent, best effort: history
 * is a convenience, so a failed listing must not fail whatever asked for it.
 */
export const backfillFromGateway = async (
  db: Db,
  agent: Agent,
  gateway: Pick<AnthropicGateway, "listSessions"> | null
): Promise<void> => {
  const { anthropicAgentId } = agent;
  if (!(gateway && anthropicAgentId) || agent.runtime !== "managed") {
    return;
  }
  await backfillAgentSessions(db, agent, () =>
    gateway.listSessions(anthropicAgentId)
  ).catch(() => undefined);
};
