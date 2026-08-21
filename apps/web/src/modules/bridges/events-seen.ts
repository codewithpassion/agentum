import type { Db } from "#/db/client";
import { slackEventsSeen } from "./schema";

/**
 * Claims a unit of at-most-once work. The insert is the lock: `ON CONFLICT DO
 * NOTHING` makes the second caller for the same key return false without doing
 * any work.
 *
 * Two kinds of key go in here, and they cannot collide - a delivery id is
 * `Ev…`, a message identity is `channel:ts`:
 *
 * - `event_id`, which stops Slack's retry of a delivery it believes failed;
 * - `channel:ts`, which stops the *same message* being published twice when it
 *   arrives as both `message` and `app_mention` under two different delivery
 *   ids. Those are two Worker invocations racing, so the claim has to be the
 *   atomic insert - reading `external_refs` first cannot settle it.
 */
export const claimSlackKey = async (db: Db, key: string): Promise<boolean> => {
  const claimed = await db
    .insert(slackEventsSeen)
    .values({ eventId: key })
    .onConflictDoNothing()
    .returning({ eventId: slackEventsSeen.eventId });
  return claimed.length > 0;
};
