import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { INBOX_AUTHOR_KINDS } from "../shared.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

/** A conversation anyone in the workspace can read and post to. */
export const inboxThreads = sqliteTable(
  "inbox_threads",
  {
    createdAt: createdAt(),
    // Clerk user id who opened the thread.
    createdBy: text("created_by").notNull(),
    id: id(),
    // Orders the thread list: the creation time until the first post.
    lastPostAt: text("last_post_at").notNull(),
    title: text("title").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [index("inbox_threads_recent_idx").on(t.workspaceId, t.lastPostAt)]
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
