import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `author_id` carries no foreign key: a revision is written either by the human
 * (a Clerk user id) or by an agent (an id owned by the agents module), and the
 * wiki module must not depend on another module's tables. The id is resolved
 * for display at read time, so a dangling one simply renders as unknown.
 */

export const WIKI_AUTHOR_TYPES = ["user", "agent"] as const;

export const wikiPages = sqliteTable("wiki_pages", {
  /** Markdown. */
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  /** Stable for the life of the page: renaming must not break links or anchors. */
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const wikiRevisions = sqliteTable(
  "wiki_revisions",
  {
    authorId: text("author_id").notNull(),
    authorType: text("author_type", { enum: WIKI_AUTHOR_TYPES }).notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
  },
  (table) => [
    index("wiki_revisions_page_created_idx").on(table.pageId, table.createdAt),
  ]
);

export const wikiAssets = sqliteTable(
  "wiki_assets",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    filename: text("filename").notNull(),
    id: text("id").primaryKey(),
    mime: text("mime").notNull(),
    /**
     * Null while the asset is only referenced from an editor draft: an upload
     * can happen before the page it belongs to exists.
     */
    pageId: text("page_id").references(() => wikiPages.id, {
      onDelete: "set null",
    }),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
  },
  (table) => [index("wiki_assets_page_idx").on(table.pageId)]
);

export type WikiPage = typeof wikiPages.$inferSelect;
export type WikiRevision = typeof wikiRevisions.$inferSelect;
export type WikiAsset = typeof wikiAssets.$inferSelect;
export type WikiAuthorType = (typeof WIKI_AUTHOR_TYPES)[number];

/** Identity of whoever writes a revision - the human user or an agent. */
export interface WikiAuthor {
  id: string;
  type: WikiAuthorType;
}
