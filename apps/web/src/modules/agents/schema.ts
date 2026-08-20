import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** How the agent's registration with the Anthropic API stands. */
export const AGENT_SYNC_STATUSES = ["unregistered", "synced", "error"] as const;

/** What the agent is doing right now, as the router sees it. */
export const AGENT_STATUSES = ["idle", "queued", "working", "error"] as const;

export const agents = sqliteTable("agents", {
  /** Set in phase 2, when the agent is registered with the Anthropic API. */
  anthropicAgentId: text("anthropic_agent_id"),
  /** Avatar seed - a hex colour picked deterministically from the name. */
  avatar: text("avatar").notNull(),
  /**
   * When a connector change asked for a token rotation and a full `mcp_servers`
   * resync; null when nothing is owed. The rotation waits until the agent has
   * no session (see `sessionId`), because it invalidates the workspace MCP URL
   * a running session is holding.
   */
  connectorResyncPendingAt: integer("connector_resync_pending_at", {
    mode: "timestamp_ms",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  instructions: text("instructions").notNull().default(""),
  /**
   * SHA-256 of the per-agent secret embedded in its MCP server URL. The token
   * itself is never stored: it is returned once, when issued or rotated.
   */
  mcpTokenHash: text("mcp_token_hash").unique(),
  memoryStoreId: text("memory_store_id"),
  name: text("name").notNull().unique(),
  /** The Anthropic session the router is currently driving, if any. */
  sessionId: text("session_id"),
  soul: text("soul").notNull().default(""),
  status: text("status", { enum: AGENT_STATUSES }).notNull().default("idle"),
  /** Why the last registration attempt failed; null unless `syncStatus` is "error". */
  syncError: text("sync_error"),
  syncStatus: text("sync_status", { enum: AGENT_SYNC_STATUSES })
    .notNull()
    .default("unregistered"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Agent = typeof agents.$inferSelect;
