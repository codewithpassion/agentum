import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import {
  slackApps,
  slackRoomMessages,
  teamSlackLinks,
} from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import type { SlackRoomDirection } from "@repo/db/shared";
import { and, asc, eq, isNull, notExists } from "drizzle-orm";
import type { SlackAppRow } from "./apps.ts";

/** The Slack-linked team room a topic belongs to. */
export interface OutboundRoom {
  channelId: string;
  leadAgentId: string | null;
  ownerUserId: string | null;
  slackTeamId: string;
  teamId: string;
  teamName: string;
}

/**
 * The Slack channel a topic's team room is linked to. Null for a topic with no
 * team, a topic in another workspace, an archived or unlinked team, or a
 * limited topic, which never goes to a Slack channel.
 */
export const findOutboundRoom = async (
  db: Database,
  { threadId, workspaceId }: { threadId: string; workspaceId: string }
): Promise<OutboundRoom | null> => {
  const row = await db
    .select({
      channelId: teamSlackLinks.channelId,
      leadAgentId: teams.leadAgentId,
      ownerUserId: teams.ownerUserId,
      slackTeamId: teamSlackLinks.slackTeamId,
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(inboxThreads)
    .innerJoin(teams, eq(teams.id, inboxThreads.teamId))
    .innerJoin(teamSlackLinks, eq(teamSlackLinks.teamId, teams.id))
    .where(
      and(
        eq(inboxThreads.id, threadId),
        eq(inboxThreads.workspaceId, workspaceId),
        eq(teams.workspaceId, workspaceId),
        eq(teamSlackLinks.workspaceId, workspaceId),
        isNull(teams.archivedAt),
        notExists(
          db
            .select({ threadId: inboxThreadMembers.threadId })
            .from(inboxThreadMembers)
            .where(eq(inboxThreadMembers.threadId, inboxThreads.id))
        )
      )
    )
    .get();
  return row ?? null;
};

/** The room message row of a post, or null when the post never went to Slack. */
export const roomMessageOfPost = async (
  db: Database,
  postId: string
): Promise<{ direction: SlackRoomDirection } | null> => {
  const row = await db
    .select({ direction: slackRoomMessages.direction })
    .from(slackRoomMessages)
    .where(eq(slackRoomMessages.postId, postId))
    .get();
  return row ?? null;
};

/**
 * The Slack ts a topic's Slack thread is rooted at: the thread_ts of its
 * earliest room message in the given Slack channel, or that message's own ts
 * when it opened the thread. Messages from a channel the team was linked to
 * before are ignored, so a relink opens a new thread.
 */
export const topicRootTs = async (
  db: Database,
  {
    channelId,
    slackTeamId,
    threadId,
  }: { channelId: string; slackTeamId: string; threadId: string }
): Promise<string | null> => {
  const row = await db
    .select({
      threadTs: slackRoomMessages.threadTs,
      ts: slackRoomMessages.ts,
    })
    .from(slackRoomMessages)
    .innerJoin(inboxPosts, eq(inboxPosts.id, slackRoomMessages.postId))
    .where(
      and(
        eq(inboxPosts.threadId, threadId),
        eq(slackRoomMessages.slackTeamId, slackTeamId),
        eq(slackRoomMessages.channelId, channelId)
      )
    )
    .orderBy(asc(slackRoomMessages.createdAt), asc(slackRoomMessages.id))
    .limit(1)
    .get();
  return row ? (row.threadTs ?? row.ts) : null;
};

export interface SenderApp {
  agentId: string;
  agentName: string;
  app: SlackAppRow;
}

/**
 * The installed Slack apps of the active agents that are members of a team,
 * in one Slack workspace. Each one can post into the team's channel.
 */
export const memberSenderApps = async (
  db: Database,
  {
    slackTeamId,
    teamId,
    workspaceId,
  }: { slackTeamId: string; teamId: string; workspaceId: string }
): Promise<SenderApp[]> =>
  await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      app: slackApps,
    })
    .from(teamMembers)
    .innerJoin(agents, eq(agents.id, teamMembers.memberId))
    .innerJoin(slackApps, eq(slackApps.agentId, agents.id))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.memberKind, "agent"),
        eq(teamMembers.workspaceId, workspaceId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.status, "active"),
        eq(slackApps.status, "installed"),
        eq(slackApps.teamId, slackTeamId),
        eq(slackApps.workspaceId, workspaceId)
      )
    )
    .orderBy(asc(slackApps.createdAt), asc(slackApps.id));

/**
 * Records an outbound Slack message against its post. A message already
 * recorded keeps its row.
 */
export const recordOutMessage = async (
  db: Database,
  {
    channelId,
    createdAt,
    id,
    postId,
    slackTeamId,
    threadTs,
    ts,
    workspaceId,
  }: {
    channelId: string;
    createdAt: string;
    id: string;
    postId: string;
    slackTeamId: string;
    threadTs: string | null;
    ts: string;
    workspaceId: string;
  }
): Promise<void> => {
  await db
    .insert(slackRoomMessages)
    .values({
      channelId,
      createdAt,
      direction: "out",
      id,
      postId,
      slackTeamId,
      threadTs,
      ts,
      workspaceId,
    })
    .onConflictDoNothing();
};
