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

export const channels = sqliteTable(
  "channels",
  {
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
  },
  // Channel names are not unique, so unlike agents and skills this table has no
  // composite unique to ride on: the workspace list needs its own index.
  (table) => [index("channels_workspace_idx").on(table.workspaceId)]
);

export const EXTERNAL_LINK_SOURCES = ["auto", "manual"] as const;

/**
 * Who an `authorType: "external"` author actually is. Two things a bridged
 * surface knows about a person that a bare `slack:U…` does not say: what to
 * call them, and which workspace member they are.
 *
 * Keyed by exactly the string in `messages.author_id`, so resolving a message
 * batch is one `IN` and no parsing. Rows only exist for people a connector has
 * seen - the app's own `routine:` and `question:` authors have none, and keep
 * the labels the client gives them.
 *
 * Resolved at *read* time rather than denormalised onto the message: a link
 * that is corrected later has to fix the history it already wrote, not just
 * what comes next.
 *
 * `workspace_id` is the tenant boundary. It is not redundant with the author
 * id: one Slack user can be a person in two workspaces, and `member_id` means
 * nothing outside the one it was resolved in.
 */
export const externalAuthors = sqliteTable(
  "external_authors",
  {
    /** Exactly `messages.author_id`, e.g. `slack:U0AHBBYVAN5`. */
    authorId: text("author_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** What the surface calls them - the fallback when nobody is linked. */
    displayName: text("display_name").notNull(),
    /**
     * How `member_id` was decided. A `manual` link is a person's own correction
     * and is never overwritten by the automatic match.
     */
    linkSource: text("link_source", { enum: EXTERNAL_LINK_SOURCES }),
    /** The `workspace_members` row this person is, once known. */
    memberId: text("member_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.authorId] }),
    index("external_authors_member_idx").on(table.workspaceId, table.memberId),
  ]
);

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
export type ExternalAuthor = typeof externalAuthors.$inferSelect;
