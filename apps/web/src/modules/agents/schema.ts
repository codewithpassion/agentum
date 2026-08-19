import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  /** Set in phase 2, when the agent is registered with the Anthropic API. */
  anthropicAgentId: text("anthropic_agent_id"),
  /** Avatar seed - a hex colour picked deterministically from the name. */
  avatar: text("avatar").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  instructions: text("instructions").notNull().default(""),
  /** Per-agent secret embedded in its MCP server URL. Issued in phase 2. */
  mcpToken: text("mcp_token"),
  memoryStoreId: text("memory_store_id"),
  name: text("name").notNull().unique(),
  soul: text("soul").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Agent = typeof agents.$inferSelect;
