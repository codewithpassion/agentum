/**
 * The Slack side of linking a team room: the channels the team's lead app can
 * see, whether that app may post in one channel, and a channel's name. The lead's
 * app answers first, then the other member apps, oldest first. An app with no
 * readable token is skipped.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { slackApps } from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import type { TeamSlackChannels } from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { invalid } from "../errors.ts";
import {
  createSecretReader,
  type SecretReader,
  type SlackAppRow,
} from "./apps.ts";
import {
  createSlackClient,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";

export interface RoomChannelsDeps {
  db: Database;
  fetch: SlackFetch;
  secretsKey?: string;
}

interface AppQuery {
  /** Only apps in this Slack workspace. */
  slackTeamId?: string;
  teamId: string;
  workspaceId: string;
}

/** The installed apps of the team's active agent members: the lead's first, then the oldest. */
export const roomApps = async (
  db: Database,
  { slackTeamId, teamId, workspaceId }: AppQuery
): Promise<SlackAppRow[]> => {
  const [team] = await db
    .select({ leadAgentId: teams.leadAgentId })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)));
  const rows = await db
    .select({ app: slackApps })
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
        eq(slackApps.workspaceId, workspaceId)
      )
    )
    .orderBy(asc(slackApps.createdAt), asc(slackApps.id));
  const apps = rows
    .map(({ app }) => app)
    .filter((app) => slackTeamId === undefined || app.teamId === slackTeamId);
  const leadId = team?.leadAgentId ?? null;
  return [
    ...apps.filter((app) => app.agentId === leadId),
    ...apps.filter((app) => app.agentId !== leadId),
  ];
};

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name);

export const createRoomChannels = ({
  db,
  fetch,
  secretsKey,
}: RoomChannelsDeps) => {
  const secrets: SecretReader = createSecretReader(secretsKey);

  /** A client for the app's bot token, or null when the app has none that can be read. */
  const clientFor = async (app: SlackAppRow): Promise<SlackClient | null> => {
    try {
      const token = await secrets.botToken(app);
      return token === null ? null : createSlackClient({ fetch, token });
    } catch {
      return null;
    }
  };

  /** The channels the lead's app is in. Throws `invalid` when no app could ask Slack. */
  const list = async (
    workspaceId: string,
    teamId: string
  ): Promise<TeamSlackChannels> => {
    const apps = await roomApps(db, { teamId, workspaceId });
    if (apps.length === 0) {
      return { channels: [], slackTeamId: null };
    }
    let failure = "no_token";
    for (const app of apps) {
      // biome-ignore lint/performance/noAwaitInLoops: the apps are tried in order, the first answer wins
      const client = await clientFor(app);
      if (client === null) {
        continue;
      }
      const result = await client.listChannels();
      if (result.kind === "ok") {
        return {
          channels: result.channels
            .map(({ id, isPrivate, name }) => ({ id, isPrivate, name }))
            .sort(byName),
          slackTeamId: app.teamId,
        };
      }
      failure = "error" in result ? result.error : result.kind;
    }
    throw invalid(`Slack would not list the channels (${failure}).`);
  };

  /** True when the lead's app (or, failing that, another member app) in the Slack workspace is a member of the channel. */
  const canPost = async (
    workspaceId: string,
    teamId: string,
    slackTeamId: string,
    channelId: string
  ): Promise<boolean> => {
    const apps = await roomApps(db, { slackTeamId, teamId, workspaceId });
    for (const app of apps) {
      // biome-ignore lint/performance/noAwaitInLoops: the apps are tried in order, the first answer wins
      const client = await clientFor(app);
      if (client === null) {
        continue;
      }
      const membership = await client.channelMembership(channelId);
      if (membership.kind === "ok" && membership.isMember) {
        return true;
      }
    }
    return false;
  };

  /** The channel's name, or null when no member app can read it. */
  const nameOf = async (
    workspaceId: string,
    teamId: string,
    slackTeamId: string,
    channelId: string
  ): Promise<string | null> => {
    const apps = await roomApps(db, { slackTeamId, teamId, workspaceId });
    for (const app of apps) {
      // biome-ignore lint/performance/noAwaitInLoops: the apps are tried in order, the first answer wins
      const client = await clientFor(app);
      if (client === null) {
        continue;
      }
      const result = await client.channelName(channelId);
      if (result.kind === "ok" && result.name !== null) {
        return result.name;
      }
    }
    return null;
  };

  return { canPost, list, nameOf };
};

export type RoomChannels = ReturnType<typeof createRoomChannels>;
