// A hand-off request posted in the Team diary topic wakes the lead. When that
// wake was refused (the lead had used its wakes for the hour), the post is
// still there, so a later tick wakes the lead for it: when the lead has no run
// since the post and its wake budget allows one.
import type { Database } from "@repo/db";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { teams } from "@repo/db/schema/teams";
import { and, asc, eq, gte, isNotNull, isNull, like } from "drizzle-orm";
import type { InboxService } from "../../inbox.ts";
import type { Clock } from "../../runs/types.ts";
import { HAND_OFF_HEADING, TEAM_DIARY_TOPIC } from "./collect.ts";

const HOUR_MS = 60 * 60_000;
/** A request older than this is no longer retried. */
const RETRY_WINDOW_MS = 24 * HOUR_MS;

export interface HandOffRetryDeps {
  clock: Clock;
  db: Database;
  inbox: Pick<InboxService, "retryNoticeWake">;
}

export interface HandOffRetryResult {
  /** The post ids whose lead was woken by this call. */
  woken: string[];
}

export const createHandOffRetrier = (deps: HandOffRetryDeps) => {
  const { clock, db, inbox } = deps;

  const retry = async (): Promise<HandOffRetryResult> => {
    const since = new Date(clock.now().getTime() - RETRY_WINDOW_MS);
    const requests = await db
      .select({
        leadAgentId: teams.leadAgentId,
        ownerUserId: teams.ownerUserId,
        postId: inboxPosts.id,
      })
      .from(inboxPosts)
      .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
      .innerJoin(teams, eq(teams.id, inboxThreads.teamId))
      .where(
        and(
          eq(inboxThreads.title, TEAM_DIARY_TOPIC),
          like(inboxPosts.text, `${HAND_OFF_HEADING}%`),
          gte(inboxPosts.createdAt, since.toISOString()),
          isNull(teams.archivedAt),
          isNotNull(teams.leadAgentId),
          isNotNull(teams.ownerUserId)
        )
      )
      .orderBy(asc(inboxPosts.id));
    const woken: string[] = [];
    for (const request of requests) {
      if (!(request.leadAgentId && request.ownerUserId)) {
        continue;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one request at a time, so a woken lead answers the older post before the next is judged
        const runs = await inbox.retryNoticeWake(
          { kind: "system" },
          request.postId,
          { agentId: request.leadAgentId, asUserId: request.ownerUserId }
        );
        if (runs.length > 0) {
          woken.push(request.postId);
        }
      } catch {
        // The next tick tries again.
      }
    }
    return { woken };
  };

  return { retry };
};
