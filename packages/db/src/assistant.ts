import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import {
  assistantConversations,
  assistantMessages,
} from "./schema/assistant.ts";

export const conversationOwner = (workspaceId: string, userId: string) =>
  and(
    eq(assistantConversations.workspaceId, workspaceId),
    eq(assistantConversations.userId, userId)
  );
export const CONVERSATION_PAGE_LIMIT = 50;

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, "\\$&");

/** One page of a person's open conversations, newest activity first, after `cursor` (`updatedAt` and id of the last row). */
export const listConversations = (
  db: Database,
  workspaceId: string,
  userId: string,
  {
    after,
    limit = CONVERSATION_PAGE_LIMIT,
    query,
  }: {
    after?: { at: string; id: string };
    limit?: number;
    /** Keeps conversations whose title contains this text. */
    query?: string;
  } = {}
) =>
  db
    .select()
    .from(assistantConversations)
    .where(
      and(
        conversationOwner(workspaceId, userId),
        isNull(assistantConversations.archivedAt),
        query === undefined || query === ""
          ? undefined
          : sql`${assistantConversations.title} LIKE ${`%${likeEscape(query)}%`} ESCAPE '\\'`,
        after === undefined
          ? undefined
          : sql`(${assistantConversations.updatedAt}, ${assistantConversations.id}) < (${after.at}, ${after.id})`
      )
    )
    .orderBy(
      desc(assistantConversations.updatedAt),
      desc(assistantConversations.id)
    )
    .limit(Math.min(limit, CONVERSATION_PAGE_LIMIT));
export const findConversation = async (
  db: Database,
  workspaceId: string,
  userId: string,
  id: string
) =>
  (
    await db
      .select()
      .from(assistantConversations)
      .where(
        and(
          conversationOwner(workspaceId, userId),
          eq(assistantConversations.id, id)
        )
      )
  )[0];
export const conversationMessages = (db: Database, conversationId: string) =>
  db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.seq));
/** The newest `limit` messages before `beforeSeq`, oldest first. */
export const conversationMessagesPage = async (
  db: Database,
  conversationId: string,
  {
    beforeSeq,
    limit = CONVERSATION_PAGE_LIMIT,
  }: { beforeSeq?: number; limit?: number } = {}
) =>
  (
    await db
      .select()
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          beforeSeq === undefined
            ? undefined
            : lt(assistantMessages.seq, beforeSeq)
        )
      )
      .orderBy(desc(assistantMessages.seq))
      .limit(Math.min(limit, CONVERSATION_PAGE_LIMIT))
  ).reverse();
export const insertConversation = (
  db: Database,
  row: typeof assistantConversations.$inferInsert
) => db.insert(assistantConversations).values(row);
export const insertMessage = (
  db: Database,
  row: typeof assistantMessages.$inferInsert
) => db.insert(assistantMessages).values(row);
export const updateConversation = (
  db: Database,
  id: string,
  updatedAt: string,
  archivedAt?: string
) =>
  db
    .update(assistantConversations)
    .set({ updatedAt, ...(archivedAt ? { archivedAt } : {}) })
    .where(eq(assistantConversations.id, id));

/** Internal lookup after the service has checked conversation ownership. */
export const conversationById = async (db: Database, id: string) =>
  (
    await db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, id))
  )[0];
export const claimCardResult = (
  db: Database,
  row: typeof assistantMessages.$inferInsert
) =>
  db
    .insert(assistantMessages)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: assistantMessages.id });
export const updateMessageContent = (
  db: Database,
  id: string,
  content: unknown
) =>
  db
    .update(assistantMessages)
    .set({ content })
    .where(eq(assistantMessages.id, id));

/** Conditional lease; a dead Worker stops excluding new turns after expiry. */
export const claimConversation = (
  db: Database,
  id: string,
  now: string,
  busyUntil: string,
  leaseId: string
) =>
  db
    .update(assistantConversations)
    .set({ busyUntil, leaseId })
    .where(
      and(
        eq(assistantConversations.id, id),
        or(
          isNull(assistantConversations.busyUntil),
          lte(assistantConversations.busyUntil, now)
        )
      )
    )
    .returning({ id: assistantConversations.id });

export const releaseConversation = (
  db: Database,
  id: string,
  leaseId: string
) =>
  db
    .update(assistantConversations)
    .set({ busyUntil: null, leaseId: null })
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.leaseId, leaseId)
      )
    );

/** Renew only a live lease; an expired Worker must never resume a turn. */
export const renewConversation = (
  db: Database,
  id: string,
  leaseId: string,
  now: string,
  busyUntil: string
) =>
  db
    .update(assistantConversations)
    .set({ busyUntil })
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.leaseId, leaseId),
        gt(assistantConversations.busyUntil, now)
      )
    )
    .returning({ id: assistantConversations.id });
