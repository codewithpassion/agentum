import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * `member_id` and `message_mentions.agent_id` deliberately carry no foreign key
 * to `agents`: the messaging module owns this schema and must not depend on
 * another module's tables. Agent rows are resolved through the agents module's
 * public service at read time, so a dangling id simply resolves to nothing.
 *
 * `channels.workspace_id` is the tenant boundary, and follows the same rule -
 * no foreign key to `workspaces`. It is the *only* workspace column in this
 * module: `channel_members`, `messages`, `attachments` and `message_mentions`
 * inherit tenancy through their channel, so reaching one by bare id means
 * resolving its channel within the workspace first.
 */

export const MEMBER_TYPES = ["user", "agent"] as const;
export const AUTHOR_TYPES = ["user", "agent", "external"] as const;
export const CHANNEL_KINDS = ["channel", "dm"] as const;

export const channels = sqliteTable("channels", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  kind: text("kind", { enum: CHANNEL_KINDS }).notNull().default("channel"),
  name: text("name").notNull(),
  /** Which surface the channel came from - `native` unless a connector made it. */
  origin: text("origin").notNull().default("native"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  workspaceId: text("workspace_id").notNull(),
});

export const channelMembers = sqliteTable(
  "channel_members",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    memberId: text("member_id").notNull(),
    memberType: text("member_type", { enum: MEMBER_TYPES }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.channelId, table.memberType, table.memberId],
    }),
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    authorId: text("author_id").notNull(),
    authorType: text("author_type", { enum: AUTHOR_TYPES }).notNull(),
    /** Markdown. */
    body: text("body").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    origin: text("origin").notNull().default("native"),
    threadParentId: text("thread_parent_id"),
  },
  (table) => [
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_thread_parent_idx").on(table.threadParentId),
  ]
);

export const attachments = sqliteTable(
  "attachments",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    filename: text("filename").notNull(),
    id: text("id").primaryKey(),
    /**
     * Null until the attachment is linked to a message: uploads happen before
     * the message that carries them exists.
     */
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    mime: text("mime").notNull(),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
  },
  (table) => [index("attachments_message_idx").on(table.messageId)]
);

export const messageMentions = sqliteTable(
  "message_mentions",
  {
    agentId: text("agent_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.agentId] })]
);

export type Channel = typeof channels.$inferSelect;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
