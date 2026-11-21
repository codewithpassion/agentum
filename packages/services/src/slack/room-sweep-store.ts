import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
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
import { encodeTime } from "ulidx";

/** The most posts one sweep returns. */
export const SWEEP_LIMIT = 50;

/** Posts created after `after` and at or before `before`, both ISO strings. */
export interface SweepWindow {
  after: string;
  before: string;
}

const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
/** A post id is written a little after its `created_at`, so the id bound starts a minute early. */
const ID_SLACK_MS = 60_000;

/**
 * Post ids are ULIDs, so the window also bounds the primary key. That keeps the
 * sweep from reading every post there is: `created_at` has no index.
 */
const postsInWindow = ({ after, before }: SweepWindow) =>
  and(
    gt(
      inboxPosts.id,
      encodeTime(Date.parse(after) - ID_SLACK_MS, ULID_TIME_LENGTH) +
        "0".repeat(ULID_RANDOM_LENGTH)
    ),
    gt(inboxPosts.createdAt, after),
    lte(inboxPosts.createdAt, before)
  );

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
 * Posts a person wrote in Slack that no wake has seen: no run started in the
 * topic since they were posted, and no wake recorded a stop. Newest first.
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
        // A run is created in the same write that moves its session's `lastRunAt`.
        notExists(
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.origin, "inbox"),
                eq(sessions.externalKey, inboxPosts.threadId),
                eq(sessions.workspaceId, inboxPosts.workspaceId),
                gte(sessions.lastRunAt, inboxPosts.createdAt)
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
