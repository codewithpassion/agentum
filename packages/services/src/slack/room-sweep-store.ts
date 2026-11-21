import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { slackRoomMessages, teamSlackLinks } from "@repo/db/schema/slack";
import { teams } from "@repo/db/schema/teams";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  gte,
  isNull,
  lte,
  ne,
  notExists,
  sql,
} from "drizzle-orm";

/** The most posts one sweep returns. */
export const SWEEP_LIMIT = 50;

/** Posts created after `after` and at or before `before`, both ISO strings. */
export interface SweepWindow {
  after: string;
  before: string;
}

const postsInWindow = ({ after, before }: SweepWindow) =>
  and(gt(inboxPosts.createdAt, after), lte(inboxPosts.createdAt, before));

/**
 * The post's thread belongs to an unarchived team that had a Slack link when
 * the post was created.
 */
const linkedRoomAtPost = (db: Database) =>
  exists(
    db
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(teamSlackLinks, eq(teamSlackLinks.teamId, teams.id))
      .where(
        and(
          eq(teams.id, inboxThreads.teamId),
          isNull(teams.archivedAt),
          eq(teams.workspaceId, inboxPosts.workspaceId),
          eq(teamSlackLinks.workspaceId, inboxPosts.workspaceId),
          lte(teamSlackLinks.createdAt, inboxPosts.createdAt)
        )
      )
  );

/**
 * Posts a person wrote in Slack that no wake has seen: the run that answers
 * them started after they were posted. Newest first.
 */
export const lostInboundPosts = async (
  db: Database,
  window: SweepWindow
): Promise<string[]> => {
  const rows = await db
    .select({ id: inboxPosts.id })
    .from(inboxPosts)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
    .where(
      and(
        postsInWindow(window),
        eq(inboxPosts.authorKind, "user"),
        isNull(inboxPosts.guestName),
        linkedRoomAtPost(db),
        exists(
          db
            .select({ id: slackRoomMessages.id })
            .from(slackRoomMessages)
            .where(
              and(
                eq(slackRoomMessages.postId, inboxPosts.id),
                eq(slackRoomMessages.direction, "in")
              )
            )
        ),
        notExists(
          db
            .select({ id: runs.id })
            .from(runs)
            .innerJoin(sessions, eq(sessions.id, runs.sessionId))
            .where(
              and(
                eq(sessions.origin, "inbox"),
                eq(sessions.externalKey, inboxPosts.threadId),
                eq(sessions.workspaceId, inboxPosts.workspaceId),
                gte(runs.createdAt, inboxPosts.createdAt)
              )
            )
        ),
        notExists(
          db
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, inboxPosts.workspaceId),
                eq(events.type, "inbox.loop_stopped"),
                sql`json_extract(${events.payload}, '$.postId') = ${inboxPosts.id}`
              )
            )
        )
      )
    )
    .orderBy(desc(inboxPosts.id))
    .limit(SWEEP_LIMIT);
  return rows.map((row) => row.id);
};

/**
 * Posts in a Slack-linked team room that never reached Slack: no room message,
 * a failed send, or a limited topic that never goes to Slack. Newest first.
 */
export const unsentRoomPosts = async (
  db: Database,
  window: SweepWindow
): Promise<string[]> => {
  const rows = await db
    .select({ id: inboxPosts.id })
    .from(inboxPosts)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
    .where(
      and(
        postsInWindow(window),
        isNull(inboxPosts.guestName),
        ne(inboxPosts.text, ""),
        linkedRoomAtPost(db),
        notExists(
          db
            .select({ threadId: inboxThreadMembers.threadId })
            .from(inboxThreadMembers)
            .where(eq(inboxThreadMembers.threadId, inboxThreads.id))
        ),
        notExists(
          db
            .select({ id: slackRoomMessages.id })
            .from(slackRoomMessages)
            .where(eq(slackRoomMessages.postId, inboxPosts.id))
        ),
        notExists(
          db
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, inboxPosts.workspaceId),
                eq(events.type, "slack.room_send_failed"),
                sql`json_extract(${events.payload}, '$.postId') = ${inboxPosts.id}`
              )
            )
        )
      )
    )
    .orderBy(desc(inboxPosts.id))
    .limit(SWEEP_LIMIT);
  return rows.map((row) => row.id);
};
