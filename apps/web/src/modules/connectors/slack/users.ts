import { inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { slackUsers } from "../schema";
import type { SlackClient } from "./client";

/**
 * `users.info` costs a round trip per author, so a name is fetched once and
 * kept. Without a bot token there is nothing to fetch and the raw `U…` id is
 * the display name - which is also what the UI falls back to.
 */
export const resolveSlackUserNames = async (
  db: Db,
  client: SlackClient | null,
  userIds: readonly string[]
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  if (userIds.length === 0) {
    return names;
  }

  const cached = await db
    .select()
    .from(slackUsers)
    .where(inArray(slackUsers.userId, [...userIds]));
  for (const row of cached) {
    names.set(row.userId, row.displayName);
  }

  const missing = userIds.filter((id) => !names.has(id));
  if (missing.length === 0 || !client) {
    return names;
  }

  for (const userId of missing) {
    // One lookup per author we have never seen, one at a time: a message rarely
    // mentions more than a couple of people, and Slack rate-limits `users.info`.
    // biome-ignore lint/performance/noAwaitInLoops: paced on purpose
    const user = await client.usersInfo(userId);
    if (!user) {
      continue;
    }
    names.set(userId, user.displayName);
    await db
      .insert(slackUsers)
      .values({ displayName: user.displayName, userId })
      .onConflictDoUpdate({
        set: { displayName: user.displayName, fetchedAt: new Date() },
        target: slackUsers.userId,
      });
  }

  return names;
};
