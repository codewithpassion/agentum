import type { TeamSlackStatus } from "@repo/db/shared";
import { botNameFrom } from "@repo/services/slack/manifest";
import { type TeamAgent, UNKNOWN_AGENT } from "./team-logic.ts";

/** A member agent whose Slack app is not in the linked channel. */
export interface MissingSlackApp {
  agentId: string;
  /** The line to paste in Slack, `/invite @<bot name>`, or null when the agent has no installed Slack app. */
  invite: string | null;
  name: string;
}

/** The apps with `inChannel === false`, in the order given. `name` comes from `agents` (match on id), else UNKNOWN_AGENT. `invite` is `/invite @${botNameFrom(name)}` when the app's `botUserId` is not null, else null. */
export const missingSlackApps = (
  apps: TeamSlackStatus["apps"],
  agents: readonly TeamAgent[]
): MissingSlackApp[] => {
  const namesById = new Map<string, string>();
  for (const agent of agents) {
    namesById.set(agent.id, agent.name);
  }
  const missing: MissingSlackApp[] = [];
  for (const app of apps) {
    if (app.inChannel) {
      continue;
    }
    const name = namesById.get(app.agentId) ?? UNKNOWN_AGENT;
    missing.push({
      agentId: app.agentId,
      invite: app.botUserId === null ? null : `/invite @${botNameFrom(name)}`,
      name,
    });
  }
  return missing;
};

/** `#ops` for a channel name, or the channel id when Slack gave no name. */
export const channelLabel = (
  channelName: string | null,
  channelId: string
): string => (channelName ? `#${channelName}` : channelId);
