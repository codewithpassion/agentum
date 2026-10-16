import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { FILE_SOURCES } from "../shared.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

export const files = sqliteTable("files", {
  createdAt: createdAt(),
  createdById: text("created_by_id").notNull(),
  createdByKind: text("created_by_kind").notNull(),
  id: id(),
  mime: text("mime").notNull(),
  name: text("name").notNull(),
  // `${workspaceId}/files/${id}`
  r2Key: text("r2_key").notNull(),
  runId: text("run_id").references(() => runs.id),
  size: integer("size").notNull(),
  source: text("source", { enum: FILE_SOURCES }).notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});
