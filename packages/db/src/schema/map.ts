import { primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaceId } from "../columns.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Where a person dragged a node on the map. A node with no row sits where the
 * layout puts it. `node_key` is `trigger:<id>`, `trigger:slack:<slackAppId>`,
 * `agent:<id>`, `out:slack:<channel>`, `out:library:<folder>`, `out:qa` or
 * `out:email:<agent>`. No foreign key: a node can be a channel or a folder.
 */
export const mapPositions = sqliteTable(
  "map_positions",
  {
    nodeKey: text("node_key").notNull(),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
    x: real("x").notNull(),
    y: real("y").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.nodeKey] })]
);
