import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * How the sidebar is grouped. `item_id` deliberately carries no foreign key to
 * `channels` or `agents`: this module owns its schema and must not depend on
 * another module's tables. Rows are resolved through those modules' public
 * services, so a dangling id simply resolves to nothing.
 *
 * `categories.workspace_id` is the tenant boundary, and carries no foreign key
 * to `workspaces` for the same reason. `category_items` inherits tenancy
 * through its category and gets no column: its `(item_type, item_id)` primary
 * key stays safe because item ids are globally unique.
 */

export const CATEGORY_ITEM_TYPES = ["channel", "agent"] as const;

export const categories = sqliteTable("categories", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workspaceId: text("workspace_id").notNull(),
});

export const categoryItems = sqliteTable(
  "category_items",
  {
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    itemType: text("item_type", { enum: CATEGORY_ITEM_TYPES }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemType, table.itemId] })]
);

export type Category = typeof categories.$inferSelect;
export type CategoryItem = typeof categoryItems.$inferSelect;
