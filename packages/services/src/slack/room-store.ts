import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import {
  slackApps,
  slackRoomMessages,
  teamSlackLinks,
} from "@repo/db/schema/slack";
import { teams } from "@repo/db/schema/teams";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { isInTeam } from "../inbox/room-access.ts";

/** The most Slack bot user ids one lookup resolves. */
const BOT_USER_LOOKUP_LIMIT = 50;

interface ChannelInWorkspace {
  channelId: string;
  slackTeamId: string;
  workspaceId: string;
}

interface SlackChannel {
  channelId: string;
  slackTeamId: string;
}

/** The team a Slack channel is linked to in an Agentum workspace. */
export const findRoomLink = async (
  db: Database,
  { channelId, slackTeamId, workspaceId }: ChannelInWorkspace
): Promise<{ teamId: string } | null> => {
  const row = await db
    .select({ teamId: teamSlackLinks.teamId })
    .from(teamSlackLinks)
    .innerJoin(teams, eq(teams.id, teamSlackLinks.teamId))
    .where(
      and(
        eq(teamSlackLinks.channelId, channelId),
        eq(teamSlackLinks.slackTeamId, slackTeamId),
        eq(teamSlackLinks.workspaceId, workspaceId),
        isNull(teams.archivedAt)
      )
    )
    .get();
  return row ? { teamId: row.teamId } : null;
};

/** True when a Slack message already has a room message row. */
export const roomMessageExists = async (
  db: Database,
  { channelId, slackTeamId, ts }: SlackChannel & { ts: string }
): Promise<boolean> => {
  const row = await db
    .select({ id: slackRoomMessages.id })
    .from(slackRoomMessages)
    .where(
      and(
        eq(slackRoomMessages.slackTeamId, slackTeamId),
        eq(slackRoomMessages.channelId, channelId),
        eq(slackRoomMessages.ts, ts)
      )
    )
    .get();
  return row !== undefined;
};

/**
 * The topic a Slack thread belongs to in a team room: the topic of its first
 * message or of its earliest reply. Null when no message of the thread is in
 * the room.
 */
export const findRoomTopic = async (
  db: Database,
  {
    channelId,
    slackTeamId,
    teamId,
    threadTs,
  }: SlackChannel & { teamId: string; threadTs: string }
): Promise<string | null> => {
  const row = await db
    .select({ topicId: inboxThreads.id })
    .from(slackRoomMessages)
    .innerJoin(inboxPosts, eq(inboxPosts.id, slackRoomMessages.postId))
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
    .where(
      and(
        eq(slackRoomMessages.slackTeamId, slackTeamId),
        eq(slackRoomMessages.channelId, channelId),
        eq(inboxThreads.teamId, teamId),
        or(
          eq(slackRoomMessages.ts, threadTs),
          eq(slackRoomMessages.threadTs, threadTs)
        )
      )
    )
    .orderBy(asc(slackRoomMessages.createdAt), asc(slackRoomMessages.id))
    .limit(1)
    .get();
  return row?.topicId ?? null;
};

/**
 * The slug of the active agent in the room's team that owns each Slack bot
 * user id. An id with no such agent is left out.
 */
export const roomAgentsByBotUser = async (
  db: Database,
  {
    botUserIds,
    slackTeamId,
    teamId,
    workspaceId,
  }: {
    botUserIds: readonly string[];
    slackTeamId: string;
    teamId: string;
    workspaceId: string;
  }
): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  const lookupIds = botUserIds.slice(0, BOT_USER_LOOKUP_LIMIT);
  if (lookupIds.length === 0) {
    return result;
  }

  const candidates = await db
    .select({
      agentId: agents.id,
      agentSlug: agents.slug,
      botUserId: slackApps.botUserId,
    })
    .from(slackApps)
    .innerJoin(agents, eq(agents.id, slackApps.agentId))
    .where(
      and(
        eq(slackApps.status, "installed"),
        eq(slackApps.teamId, slackTeamId),
        eq(slackApps.workspaceId, workspaceId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.status, "active"),
        inArray(slackApps.botUserId, lookupIds)
      )
    );

  for (const candidate of candidates) {
    if (result.has(candidate.botUserId)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: at most BOT_USER_LOOKUP_LIMIT membership lookups
    if (await isInTeam(db, teamId, { id: candidate.agentId, kind: "agent" })) {
      result.set(candidate.botUserId, candidate.agentSlug);
    }
  }
  return result;
};

/** True when an installed Slack app of the workspace has this bot user id. */
export const isAppBotUser = async (
  db: Database,
  {
    slackTeamId,
    userId,
    workspaceId,
  }: { slackTeamId: string; userId: string; workspaceId: string }
): Promise<boolean> => {
  const row = await db
    .select({ id: slackApps.id })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.status, "installed"),
        eq(slackApps.teamId, slackTeamId),
        eq(slackApps.workspaceId, workspaceId),
        eq(slackApps.botUserId, userId)
      )
    )
    .get();
  return row !== undefined;
};
