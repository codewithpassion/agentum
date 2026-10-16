import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { workspaceId } from "../columns.ts";
import { LIBRARY_ENTRY_KINDS } from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/**
 * The path index of a workspace's library. Bytes live in R2 under
 * `${workspaceId}/library/${path}`; listing, stat and walks read this table.
 * Paths are normalised, with no leading slash, and the root is the empty path.
 */
export const libraryEntries = sqliteTable(
  "library_entries",
  {
    // R2 etag of the object. Null for a folder.
    etag: text("etag"),
    kind: text("kind", { enum: LIBRARY_ENTRY_KINDS }).notNull(),
    // ISO 8601 UTC.
    mtime: text("mtime").notNull(),
    // The folder holding this entry. The empty string for a top-level entry.
    parent: text("parent").notNull(),
    path: text("path").notNull(),
    // Bytes. 0 for a folder.
    size: integer("size").notNull(),
    updatedById: text("updated_by_id").notNull(),
    updatedByKind: text("updated_by_kind").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.path] }),
    index("library_entries_parent_idx").on(t.workspaceId, t.parent),
  ]
);
