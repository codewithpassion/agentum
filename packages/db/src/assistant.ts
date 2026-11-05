import { and, asc, desc, eq, isNull } from "drizzle-orm";
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
export const listConversations = (
  db: Database,
  workspaceId: string,
  userId: string
) =>
  db
    .select()
    .from(assistantConversations)
    .where(
      and(
        conversationOwner(workspaceId, userId),
        isNull(assistantConversations.archivedAt)
      )
    )
    .orderBy(desc(assistantConversations.updatedAt));
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
