import type { SlackClient } from "./client.ts";

/** One batch names at most this many authors, so a batch costs a bounded number of lookups. */
const NAMES_MAX = 25;

/**
 * The display names of up to 25 distinct Slack users, looked up in parallel.
 * Best effort: a failed lookup or a user without a name is left out, and the
 * caller falls back to the Slack id.
 */
export const nameUsers = async (
  client: SlackClient,
  userIds: readonly string[]
): Promise<Map<string, string>> => {
  const ids = [...new Set(userIds)].slice(0, NAMES_MAX);
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await client.userName(id)] as const;
      } catch {
        return [id, null] as const;
      }
    })
  );
  const names = new Map<string, string>();
  for (const [id, result] of results) {
    if (result?.kind === "ok" && result.name !== null) {
      names.set(id, result.name);
    }
  }
  return names;
};
