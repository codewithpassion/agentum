import type { Database } from "@repo/db";
import { slackApps } from "@repo/db/schema/slack";
import { and, eq } from "drizzle-orm";

export const SLACK_GUIDANCE =
  "You have a Slack app. You can start a message in a channel your bot is in, or in a DM to a linked workspace member, with the slack_send tool. List the targets with slack_destinations first. Every send is logged and there is a limit of 30 per hour. Read a channel or thread with slack_history, and search the messages stored for you with slack_search.";

export const SLACK_ALL_MESSAGES_GUIDANCE =
  "In the channels your Slack bot is in you see every message, in batches about every five minutes. You do not have to answer: stay silent unless a reply helps, and reply with slack_send, because the final answer of a batch run is not posted.";

/**
 * The Slack lines for an agent's instructions, or "" when it has no installed app.
 * The all-messages line is added once when any installed app listens to every message,
 * because the agent then gets those batches from that app.
 */
export const slackGuidanceFor = async (
  db: Database,
  query: { agentId: string; workspaceId: string }
): Promise<string> => {
  const rows = await db
    .select({ id: slackApps.id, listenMode: slackApps.listenMode })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, query.workspaceId),
        eq(slackApps.agentId, query.agentId),
        eq(slackApps.status, "installed")
      )
    );
  if (rows.length === 0) {
    return "";
  }
  const listensToAll = rows.some((row) => row.listenMode === "all");
  return listensToAll
    ? `${SLACK_GUIDANCE} ${SLACK_ALL_MESSAGES_GUIDANCE}`
    : SLACK_GUIDANCE;
};
