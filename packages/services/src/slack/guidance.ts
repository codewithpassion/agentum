import type { Database } from "@repo/db";
import { slackApps } from "@repo/db/schema/slack";
import { and, eq } from "drizzle-orm";

export const SLACK_GUIDANCE =
  "You have a Slack app. You can start a message in a channel your bot is in, or in a DM to a linked workspace member, with the slack_send tool. List the targets with slack_destinations first. Every send is logged and there is a limit of 30 per hour.";

/** The Slack line for an agent's instructions, or "" when it has no installed app. */
export const slackGuidanceFor = async (
  db: Database,
  query: { agentId: string; workspaceId: string }
): Promise<string> => {
  const [row] = await db
    .select({ id: slackApps.id })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, query.workspaceId),
        eq(slackApps.agentId, query.agentId),
        eq(slackApps.status, "installed")
      )
    )
    .limit(1);
  return row ? SLACK_GUIDANCE : "";
};
