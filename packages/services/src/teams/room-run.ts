import type { Database } from "@repo/db";
import { inboxThreads } from "@repo/db/schema/inbox";
import { sessions } from "@repo/db/schema/sessions";
import { teams } from "@repo/db/schema/teams";
import { and, eq, isNull } from "drizzle-orm";

/** The team room a lead's run was woken by. */
export interface LeadRoom {
  teamId: string;
  teamName: string;
  threadId: string;
}

/**
 * The team room `run` was woken by, when its agent leads that team. A run in
 * the inbox session of a topic is a room run, and its agent is the lead when
 * the topic's team names it and is not archived. Null for every other run,
 * including the same agent in its own conversations.
 */
export const leadRoomOf = async (
  db: Database,
  run: { agentId: string; sessionId: string; workspaceId: string }
): Promise<LeadRoom | null> => {
  const [room] = await db
    .select({
      teamId: teams.id,
      teamName: teams.name,
      threadId: inboxThreads.id,
    })
    .from(sessions)
    .innerJoin(
      inboxThreads,
      and(
        eq(inboxThreads.id, sessions.externalKey),
        eq(inboxThreads.workspaceId, sessions.workspaceId)
      )
    )
    .innerJoin(
      teams,
      and(
        eq(teams.id, inboxThreads.teamId),
        eq(teams.workspaceId, sessions.workspaceId)
      )
    )
    .where(
      and(
        eq(sessions.id, run.sessionId),
        eq(sessions.workspaceId, run.workspaceId),
        eq(sessions.origin, "inbox"),
        eq(teams.leadAgentId, run.agentId),
        isNull(teams.archivedAt)
      )
    )
    .limit(1);
  return room ?? null;
};
