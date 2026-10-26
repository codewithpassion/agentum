import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, workspaceId } from "../columns.ts";
import { TOOL_RULE_MODES } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/** No row for a tool key means allow, which is how every agent ran before rules. */
export const agentToolRules = sqliteTable(
  "agent_tool_rules",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    id: id(),
    mode: text("mode", { enum: TOOL_RULE_MODES }).notNull(),
    toolKey: text("tool_key").notNull(),
    updatedAt: text("updated_at").notNull(),
    // Clerk user id.
    updatedBy: text("updated_by").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("agent_tool_rules_unique").on(t.agentId, t.toolKey)]
);
