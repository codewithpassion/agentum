import type { Db } from "#/db/client";
import { slackEventsSeen } from "./schema";

/**
 * Claims a Slack delivery. The insert is the lock: `ON CONFLICT DO NOTHING`
 * makes a second delivery of the same `event_id` - Slack's retry - return
 * false without doing any work.
 */
export const claimSlackEvent = async (
  db: Db,
  eventId: string
): Promise<boolean> => {
  const claimed = await db
    .insert(slackEventsSeen)
    .values({ eventId })
    .onConflictDoNothing()
    .returning({ eventId: slackEventsSeen.eventId });
  return claimed.length > 0;
};
