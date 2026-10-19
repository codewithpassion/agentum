import type { Database } from "@repo/db";
import type { Statement } from "@repo/db/atomic";
import { sessions } from "@repo/db/schema/sessions";
import { slackThreads } from "@repo/db/schema/slack";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { SessionOrigin } from "../runs/types.ts";

/** A thread the agent started with `slack_send`, as it is written to `slack_threads`. */
export interface StartedThread {
  agentId: string;
  channelId: string;
  createdAt: string;
  sessionId: string;
  teamId: string;
  threadTs: string;
  workspaceId: string;
}

/** The thread a Slack message belongs to. */
export interface ThreadKey {
  agentId: string;
  channelId: string;
  teamId: string;
  threadTs: string;
  workspaceId: string;
}

/** The session a thread reply continues, with the key and origin the run should use. */
export interface ThreadSession {
  externalKey: string;
  origin: SessionOrigin;
  sessionId: string;
}

/** Records a started thread. A second start of the same thread leaves the first row. */
export const startedThreadStatement = (
  db: Database,
  row: StartedThread
): Statement =>
  db
    .insert(slackThreads)
    .values({
      agentId: row.agentId,
      channelId: row.channelId,
      createdAt: row.createdAt,
      id: ulid(),
      sessionId: row.sessionId,
      teamId: row.teamId,
      threadTs: row.threadTs,
      workspaceId: row.workspaceId,
    })
    .onConflictDoNothing();

const toThreadSession = (row: {
  externalKey: string | null;
  origin: string;
  sessionId: string;
}): ThreadSession | null =>
  row.externalKey === null
    ? null
    : {
        externalKey: row.externalKey,
        origin: row.origin as SessionOrigin,
        sessionId: row.sessionId,
      };

/**
 * The session a Slack thread belongs to: the session of a thread the agent
 * started, else the Slack session a mention in that thread opened. Null when
 * neither exists or the session has no external key.
 */
export const findThreadSession = async (
  db: Database,
  key: ThreadKey
): Promise<ThreadSession | null> => {
  const started = await db
    .select({
      externalKey: sessions.externalKey,
      origin: sessions.origin,
      sessionId: sessions.id,
    })
    .from(slackThreads)
    .innerJoin(sessions, eq(slackThreads.sessionId, sessions.id))
    .where(
      and(
        eq(slackThreads.workspaceId, key.workspaceId),
        eq(slackThreads.agentId, key.agentId),
        eq(slackThreads.teamId, key.teamId),
        eq(slackThreads.channelId, key.channelId),
        eq(slackThreads.threadTs, key.threadTs)
      )
    )
    .get();
  if (started) {
    return toThreadSession(started);
  }

  const mentionKey = `${key.teamId}:${key.channelId}:${key.threadTs}`;
  const mention = await db
    .select({
      externalKey: sessions.externalKey,
      origin: sessions.origin,
      sessionId: sessions.id,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, key.workspaceId),
        eq(sessions.agentId, key.agentId),
        eq(sessions.origin, "slack"),
        eq(sessions.externalKey, mentionKey)
      )
    )
    .get();
  return mention ? toThreadSession(mention) : null;
};
