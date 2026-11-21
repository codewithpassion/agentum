import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { INBOX_AUTHOR_KINDS, TEAM_MEMBER_KINDS } from "../shared.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { teams } from "./teams.ts";
import { workspaces } from "./workspaces.ts";

/** A conversation anyone in the workspace can read and post to. */
export const inboxThreads = sqliteTable(
  "inbox_threads",
  {
    // When a person dismissed this thread from Needs you, and who. A newer
    // agent post brings it back.
    attentionClearedAt: text("attention_cleared_at"),
    // Clerk user id.
    attentionClearedBy: text("attention_cleared_by"),
    createdAt: createdAt(),
    // Clerk user id who opened the thread.
    createdBy: text("created_by").notNull(),
    id: id(),
    // Orders the thread list: the creation time until the first post.
    lastPostAt: text("last_post_at").notNull(),
    // The agent that opened the topic, or NULL when a person did.
    openedByAgentId: text("opened_by_agent_id").references(() => agents.id),
    // The team room the topic belongs to. A new topic starts in the workspace's "Everyone" team.
    teamId: text("team_id").references(() => teams.id),
    title: text("title").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    index("inbox_threads_recent_idx").on(t.workspaceId, t.lastPostAt),
    index("inbox_threads_team_idx").on(t.teamId, t.lastPostAt),
  ]
);

/**
 * The members a topic is limited to. A topic with no rows here is open to its
 * whole team.
 */
export const inboxThreadMembers = sqliteTable(
  "inbox_thread_members",
  {
    // The agent id or the Clerk user id, by `member_kind`.
    memberId: text("member_id").notNull(),
    memberKind: text("member_kind", { enum: TEAM_MEMBER_KINDS }).notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.memberKind, t.memberId] })]
);

/**
 * Posts are append-only. `run_id` is set on an agent's post and comes from the
 * trusted delivery context, never from the post's text.
 */
export const inboxPosts = sqliteTable(
  "inbox_posts",
  {
    // Clerk user id, or the agent id.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", { enum: INBOX_AUTHOR_KINDS }).notNull(),
    createdAt: createdAt(),
    // JSON array of file ids the run produced.
    fileIds: text("file_ids").notNull().default("[]"),
    // The Slack profile name of a guest, who posts as author kind "user" with a
    // `slack:` author id. NULL on every other post.
    guestName: text("guest_name"),
    // ULID from a monotonic factory, so the id orders the thread.
    id: id(),
    runId: text("run_id").references(() => runs.id),
    text: text("text").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [index("inbox_posts_thread_idx").on(t.threadId, t.id)]
);
