/**
 * Which member agents of a team have their Slack app in the team's linked
 * channel. A failed Slack call or an unreadable token answers "not in the
 * channel" rather than failing the read.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { teamSlackLinks } from "@repo/db/schema/slack";
import { teamMembers } from "@repo/db/schema/teams";
import type {
  TeamSlackLink,
  TeamSlackMemberApp,
  TeamSlackStatus,
} from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import {
  createSecretReader,
  findInstalledApp,
  type SlackAppRow,
} from "./apps.ts";
import { createSlackClient, type SlackFetch } from "./client.ts";

export interface RoomStatusDeps {
  db: Database;
  fetch: SlackFetch;
  secretsKey?: string;
}

export const createRoomStatus = ({ db, fetch, secretsKey }: RoomStatusDeps) => {
  const secrets = createSecretReader(secretsKey);

  const readLink = async (
    workspaceId: string,
    teamId: string
  ): Promise<TeamSlackLink | null> => {
    const [row] = await db
      .select()
      .from(teamSlackLinks)
      .where(
        and(
          eq(teamSlackLinks.workspaceId, workspaceId),
          eq(teamSlackLinks.teamId, teamId)
        )
      )
      .limit(1);
    if (row === undefined) {
      return null;
    }
    return {
      channelId: row.channelId,
      createdAt: row.createdAt,
      linkedBy: row.linkedBy,
      slackTeamId: row.slackTeamId,
      teamId: row.teamId,
    };
  };

  const activeAgentIds = async (
    workspaceId: string,
    teamId: string
  ): Promise<string[]> => {
    const rows = await db
      .select({ agentId: agents.id })
      .from(teamMembers)
      .innerJoin(agents, eq(agents.id, teamMembers.memberId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.memberKind, "agent"),
          eq(agents.workspaceId, workspaceId),
          eq(agents.status, "active")
        )
      )
      .orderBy(asc(agents.id));
    return rows.map((row) => row.agentId);
  };

  const isInChannel = async (
    app: SlackAppRow,
    channelId: string
  ): Promise<boolean> => {
    try {
      const token = await secrets.botToken(app);
      if (token === null) {
        return false;
      }
      const membership = await createSlackClient({
        fetch,
        token,
      }).channelMembership(channelId);
      return membership.kind === "ok" && membership.isMember;
    } catch {
      return false;
    }
  };

  const memberApp = async (
    workspaceId: string,
    link: TeamSlackLink,
    agentId: string
  ): Promise<TeamSlackMemberApp> => {
    const app = await findInstalledApp(db, {
      agentId,
      teamId: link.slackTeamId,
      workspaceId,
    });
    if (app === null) {
      return { agentId, botUserId: null, inChannel: false };
    }
    return {
      agentId,
      botUserId: app.botUserId,
      inChannel: await isInChannel(app, link.channelId),
    };
  };

  return async (
    workspaceId: string,
    teamId: string
  ): Promise<TeamSlackStatus> => {
    const link = await readLink(workspaceId, teamId);
    if (link === null) {
      return { apps: [], link: null };
    }
    const agentIds = await activeAgentIds(workspaceId, teamId);
    const apps = await Promise.all(
      agentIds.map((agentId) => memberApp(workspaceId, link, agentId))
    );
    return { apps, link };
  };
};
