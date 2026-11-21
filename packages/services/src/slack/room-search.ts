/**
 * Search over the team room posts that a linked Slack channel feeds. A linked
 * channel's messages are stored as inbox posts, not in `slack_messages`, so
 * `searchMessages` cannot see them. This reads the posts paired with the Slack
 * messages (`slack_room_messages`), and only for agents on the room's team.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { slackRoomMessages, teamSlackLinks } from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { identityLinks } from "@repo/db/schema/workspaces";
import { and, desc, eq, gte, lte, or, type SQL, sql } from "drizzle-orm";
import type { SearchHit } from "./messages.ts";
import { SEARCH_LIMIT_MAX } from "./messages.ts";

const WHITESPACE = /\s+/;

/** Search words beyond this are dropped, as in `searchMessages`. */
const SEARCH_WORDS_MAX = 8;

const AGENT_KIND = "agent";
const GUEST_LABEL_SUFFIX = " (Slack guest)";

export interface RoomSearchInput {
  agentId: string;
  channelId?: string;
  limit: number;
  /**
   * The name a result is shown with (a guest's name, an agent's name, or a
   * person's email), or the Agentum user id of a person without an email. Matched
   * case-insensitively against that same name.
   */
  person?: string;
  query: string;
  /** ISO time, inclusive. */
  since?: string;
  slackTeamId: string;
  /** ISO time, inclusive. */
  until?: string;
  workspaceId: string;
}

/**
 * Escapes the LIKE wildcards and the escape character, as `searchMessages`
 * does. Kept here because `messages.ts` does not export it.
 */
const escapeLike = (word: string): string => word.replace(/[\\%_]/g, "\\$&");

/** The Clerk user's email in the Slack workspace of the post, or null when the person is not linked. */
const linkedEmail = sql<
  string | null
>`(select ${identityLinks.email} from ${identityLinks} where ${identityLinks.workspaceId} = ${slackRoomMessages.workspaceId} and ${identityLinks.provider} = 'slack' and ${identityLinks.teamId} = ${slackRoomMessages.slackTeamId} and ${identityLinks.clerkUserId} = ${inboxPosts.authorId} limit 1)`;

/**
 * The name a post is shown with, as `slackUserId`: the agent's name, a guest's
 * name with " (Slack guest)", the linked email, or else the author id.
 */
const shownName = sql<string>`(case
  when ${inboxPosts.authorKind} = ${AGENT_KIND} then ${agents.name}
  when ${inboxPosts.guestName} is not null then ${inboxPosts.guestName} || ${GUEST_LABEL_SUFFIX}
  when ${linkedEmail} is not null then ${linkedEmail}
  else ${inboxPosts.authorId} end)`;

/**
 * Searches the room posts of one Slack team's linked channels. Only channels
 * linked to a team the agent is in are searched: the agent is a member of the
 * team or its lead. A post whose topic is limited to members is skipped, and
 * so is a channel that is not linked. A row matches when its text contains
 * every word. Channel ids that do not start with C or G are never returned.
 */
export const searchRoomMessages = async (
  db: Database,
  input: RoomSearchInput
): Promise<SearchHit[]> => {
  const words = input.query
    .split(WHITESPACE)
    .filter((word) => word.length > 0)
    .slice(0, SEARCH_WORDS_MAX);

  const agentOnTeam = or(
    eq(teams.leadAgentId, input.agentId),
    sql`exists (select 1 from ${teamMembers} where ${teamMembers.teamId} = ${teams.id} and ${teamMembers.memberKind} = ${AGENT_KIND} and ${teamMembers.memberId} = ${input.agentId})`
  );

  const conditions: (SQL | undefined)[] = [
    eq(slackRoomMessages.workspaceId, input.workspaceId),
    eq(slackRoomMessages.slackTeamId, input.slackTeamId),
    sql`substr(${slackRoomMessages.channelId}, 1, 1) IN ('C', 'G')`,
    agentOnTeam,
    sql`not exists (select 1 from ${inboxThreadMembers} where ${inboxThreadMembers.threadId} = ${inboxPosts.threadId})`,
  ];
  if (input.channelId !== undefined) {
    conditions.push(eq(slackRoomMessages.channelId, input.channelId));
  }
  for (const word of words) {
    conditions.push(
      sql`${inboxPosts.text} LIKE ${`%${escapeLike(word)}%`} ESCAPE '\\'`
    );
  }
  if (input.person !== undefined) {
    conditions.push(sql`lower(${shownName}) = lower(${input.person})`);
  }
  if (input.since !== undefined) {
    conditions.push(gte(inboxPosts.createdAt, input.since));
  }
  if (input.until !== undefined) {
    conditions.push(lte(inboxPosts.createdAt, input.until));
  }

  const rows = await db
    .select({
      channelId: slackRoomMessages.channelId,
      clerkEmail: linkedEmail,
      createdAt: inboxPosts.createdAt,
      slackUserId: shownName,
      text: inboxPosts.text,
      threadTs: slackRoomMessages.threadTs,
      ts: slackRoomMessages.ts,
    })
    .from(slackRoomMessages)
    .innerJoin(
      teamSlackLinks,
      and(
        eq(teamSlackLinks.workspaceId, slackRoomMessages.workspaceId),
        eq(teamSlackLinks.slackTeamId, slackRoomMessages.slackTeamId),
        eq(teamSlackLinks.channelId, slackRoomMessages.channelId)
      )
    )
    .innerJoin(teams, eq(teams.id, teamSlackLinks.teamId))
    .innerJoin(inboxPosts, eq(inboxPosts.id, slackRoomMessages.postId))
    // The topic must belong to the team the channel is linked to now. An old link's
    // rows stay after an unlink, and must not reach the next team.
    .innerJoin(
      inboxThreads,
      and(
        eq(inboxThreads.id, inboxPosts.threadId),
        eq(inboxThreads.teamId, teams.id)
      )
    )
    .leftJoin(
      agents,
      and(
        eq(agents.id, inboxPosts.authorId),
        eq(inboxPosts.authorKind, AGENT_KIND)
      )
    )
    .where(and(...conditions))
    .orderBy(desc(inboxPosts.createdAt), desc(slackRoomMessages.ts))
    .limit(Math.min(input.limit, SEARCH_LIMIT_MAX));

  return rows.map(
    (row): SearchHit => ({
      channelId: row.channelId,
      clerkEmail: row.clerkEmail,
      createdAt: row.createdAt,
      slackUserId: row.slackUserId,
      text: row.text,
      threadTs: row.threadTs,
      ts: row.ts,
    })
  );
};
