import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { workspaces } from "./workspaces.ts";

export const assistantConversations = sqliteTable(
  "assistant_conversations",
  {
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    id: id(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("assistant_conversations_owner").on(t.workspaceId, t.userId)]
);

export const assistantMessages = sqliteTable(
  "assistant_messages",
  {
    content: text("content", { mode: "json" }).$type<unknown>().notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversations.id),
    createdAt: createdAt(),
    id: id(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    seq: integer("seq").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("assistant_messages_seq").on(t.conversationId, t.seq)]
);
