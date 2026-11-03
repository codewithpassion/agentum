import type { Database } from "@repo/db";
import type { Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { slackApps, slackMessages } from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";

/**
 * How long a plain channel message waits before its batch runs. A burst of
 * messages then reaches the agent as one run, not one run per message.
 */
export const BATCH_DELAY_MS = 5 * 60 * 1000;

/** Rows older than this are purged, the retention the Slack app promises. */
export const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The most messages one batch takes in and marks as handed over. The prompt
 * may show fewer (see `formatBatchPrompt`), but every message taken in is
 * marked, so a burst never causes a second batch inside the five minutes.
 */
export const BATCH_MESSAGES_MAX = 1000;

/** Caps one search, so the agent cannot pull a whole channel history in one call. */
export const SEARCH_LIMIT_MAX = 50;

const WHITESPACE = /\s+/;

/** Search words beyond this are dropped, so one query stays a bounded number of LIKE terms. */
const SEARCH_WORDS_MAX = 8;

/** D1 allows 100 bound parameters per query. 50 ids leave room for the other bindings. */
const MARK_BATCHED_CHUNK = 50;

export interface StoredMessageInput {
  appId: string;
  /** Null for a plain channel message, which waits for its batch. */
  batchedAt: string | null;
  channelId: string;
  clerkUserId: string | null;
  createdAt: string;
  slackUserId: string;
  text: string;
  threadTs: string | null;
  ts: string;
  workspaceId: string;
}

/** A message row, every column. */
export type StoredMessage = typeof slackMessages.$inferSelect;

/**
 * Stores a message the app has seen. The unique key is (app, channel, ts), so
 * a Slack retry or a second event for the same message is a no-op. Returns the
 * statement unexecuted, so the caller can put it in the same atomic write as
 * the run it belongs to.
 */
export const storeMessageStatement = (
  db: Database,
  input: StoredMessageInput
): Statement =>
  db
    .insert(slackMessages)
    .values({ ...input, id: ulid() })
    .onConflictDoNothing();

interface MessageRef {
  appId: string;
  channelId: string;
  ts: string;
}

const messageRef = (ref: MessageRef): SQL | undefined =>
  and(
    eq(slackMessages.appId, ref.appId),
    eq(slackMessages.channelId, ref.channelId),
    eq(slackMessages.ts, ref.ts)
  );

/**
 * Applies a Slack edit to the stored copy. An edit to a message that was never
 * stored matches no row and does nothing.
 */
export const updateMessageText = async (
  db: Database,
  input: MessageRef & { text: string }
): Promise<void> => {
  await db
    .update(slackMessages)
    .set({ text: input.text })
    .where(messageRef(input));
};

/** Removes a deleted message. A message that was never stored matches no row and does nothing. */
export const deleteMessage = async (
  db: Database,
  input: MessageRef
): Promise<void> => {
  await db.delete(slackMessages).where(messageRef(input));
};

/**
 * Deletes rows stored before the cutoff. Run by the minute tick, so the 90 day
 * retention holds without a separate job. It covers every app, because the
 * retention is a property of the table.
 */
export const purgeMessagesBefore = async (
  db: Database,
  cutoffIso: string
): Promise<void> => {
  await db.delete(slackMessages).where(lt(slackMessages.createdAt, cutoffIso));
};

/** A channel whose batch is due, with what the batched run needs to start. */
export interface DueBatch {
  agentId: string;
  appId: string;
  botUserId: string;
  channelId: string;
  firstMessageId: string;
  teamId: string;
  workspaceId: string;
}

/**
 * The channels whose batch is due. A batch is due when the OLDEST unbatched
 * message there was stored at or before `before`, so a burst waits for its
 * first message to age, not its last. Only apps that listen to every message
 * and whose agent is active get batches.
 */
export const findDueBatches = async (
  db: Database,
  { before }: { before: string }
): Promise<DueBatch[]> => {
  const oldest = db
    .select({
      appId: slackMessages.appId,
      channelId: slackMessages.channelId,
      createdAt: slackMessages.createdAt,
      firstMessageId: slackMessages.id,
      position:
        sql<number>`row_number() over (partition by ${slackMessages.appId}, ${slackMessages.channelId} order by ${slackMessages.createdAt}, ${slackMessages.id})`.as(
          "position"
        ),
      workspaceId: slackMessages.workspaceId,
    })
    .from(slackMessages)
    .where(isNull(slackMessages.batchedAt))
    .as("oldest");

  return await db
    .select({
      agentId: slackApps.agentId,
      appId: oldest.appId,
      botUserId: slackApps.botUserId,
      channelId: oldest.channelId,
      firstMessageId: oldest.firstMessageId,
      teamId: slackApps.teamId,
      workspaceId: oldest.workspaceId,
    })
    .from(oldest)
    .innerJoin(slackApps, eq(slackApps.id, oldest.appId))
    .innerJoin(agents, eq(agents.id, slackApps.agentId))
    .where(
      and(
        eq(oldest.position, 1),
        lte(oldest.createdAt, before),
        eq(slackApps.status, "installed"),
        eq(slackApps.listenMode, "all"),
        eq(agents.status, "active")
      )
    )
    .orderBy(asc(oldest.createdAt), asc(oldest.appId), asc(oldest.channelId));
};

/**
 * The unbatched messages of one app in one channel, oldest first. Capped, so a
 * long quiet spell in a busy channel becomes several batches, not one huge run.
 */
export const unbatchedMessages = async (
  db: Database,
  { appId, channelId }: { appId: string; channelId: string }
): Promise<StoredMessage[]> =>
  await db
    .select()
    .from(slackMessages)
    .where(
      and(
        eq(slackMessages.appId, appId),
        eq(slackMessages.channelId, channelId),
        isNull(slackMessages.batchedAt)
      )
    )
    .orderBy(asc(slackMessages.createdAt), asc(slackMessages.ts))
    .limit(BATCH_MESSAGES_MAX);

/**
 * Marks messages as handed to the agent. Chunked, because one D1 query takes
 * at most 100 bound parameters. Returns the statements unexecuted, so they
 * join the run's atomic write.
 */
export const markBatchedStatements = (
  db: Database,
  { batchedAt, ids }: { batchedAt: string; ids: readonly string[] }
): Statement[] => {
  const statements: Statement[] = [];
  for (let start = 0; start < ids.length; start += MARK_BATCHED_CHUNK) {
    statements.push(
      db
        .update(slackMessages)
        .set({ batchedAt })
        .where(
          inArray(
            slackMessages.id,
            ids.slice(start, start + MARK_BATCHED_CHUNK)
          )
        )
    );
  }
  return statements;
};

/** A search result. `clerkEmail` is the linked Agentum user's email, when the Slack user is linked. */
export interface SearchHit {
  channelId: string;
  clerkEmail: string | null;
  createdAt: string;
  slackUserId: string;
  text: string;
  threadTs: string | null;
  ts: string;
}

export interface SearchInput {
  appId: string;
  channelId?: string;
  limit: number;
  /** A Slack user id, or the email of the Agentum user linked to one. */
  person?: string;
  query: string;
  /** ISO time, inclusive. */
  since?: string;
  teamId: string;
  /** ISO time, inclusive. */
  until?: string;
  workspaceId: string;
}

/**
 * Escapes the LIKE wildcards and the escape character itself, so a search for
 * `100%` or `my_var` matches those characters and not a pattern.
 */
const escapeLike = (word: string): string => word.replace(/[\\%_]/g, "\\$&");

/**
 * Searches one app's stored channel messages. A row matches when its text
 * contains every word. DMs (channel ids starting with D) are never searched,
 * because the agent should not read a person's direct messages through a
 * channel search.
 */
export const searchMessages = async (
  db: Database,
  input: SearchInput
): Promise<SearchHit[]> => {
  const words = input.query
    .split(WHITESPACE)
    .filter((word) => word.length > 0)
    .slice(0, SEARCH_WORDS_MAX);

  const conditions: (SQL | undefined)[] = [
    eq(slackMessages.appId, input.appId),
    eq(slackMessages.workspaceId, input.workspaceId),
    sql`substr(${slackMessages.channelId}, 1, 1) IN ('C', 'G')`,
  ];
  if (input.channelId !== undefined) {
    conditions.push(eq(slackMessages.channelId, input.channelId));
  }
  for (const word of words) {
    conditions.push(
      sql`${slackMessages.text} LIKE ${`%${escapeLike(word)}%`} ESCAPE '\\'`
    );
  }
  if (input.person !== undefined) {
    conditions.push(
      or(
        eq(slackMessages.slackUserId, input.person),
        sql`lower(${identityLinks.email}) = lower(${input.person})`
      )
    );
  }
  if (input.since !== undefined) {
    conditions.push(gte(slackMessages.createdAt, input.since));
  }
  if (input.until !== undefined) {
    conditions.push(lte(slackMessages.createdAt, input.until));
  }

  return await db
    .select({
      channelId: slackMessages.channelId,
      clerkEmail: identityLinks.email,
      createdAt: slackMessages.createdAt,
      slackUserId: slackMessages.slackUserId,
      text: slackMessages.text,
      threadTs: slackMessages.threadTs,
      ts: slackMessages.ts,
    })
    .from(slackMessages)
    .leftJoin(
      identityLinks,
      and(
        eq(identityLinks.workspaceId, slackMessages.workspaceId),
        eq(identityLinks.provider, "slack"),
        eq(identityLinks.teamId, input.teamId),
        eq(identityLinks.externalUserId, slackMessages.slackUserId)
      )
    )
    .where(and(...conditions))
    .orderBy(desc(slackMessages.createdAt), desc(slackMessages.ts))
    .limit(Math.min(input.limit, SEARCH_LIMIT_MAX));
};
