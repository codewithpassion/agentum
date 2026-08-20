import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Two tables, both keyed by `agent_id` with no foreign key - the browser module
 * must not depend on the agents module's tables, the same rule the activity log
 * follows.
 *
 * Neither carries a `workspace_id`: both are children of an agent and inherit
 * their tenancy from `agents.workspace_id`. Reaching one by bare id means
 * resolving its agent within the workspace first.
 */

/**
 * The one Browser Run session an agent has open, if any. A row here is what
 * lets the next MCP call land on the page the last one left open: the Worker
 * isolate that navigated is long gone, but the session it acquired is not.
 * Browser Run closes the session on its own once it goes idle, so a stale row
 * is normal and simply means the next call launches a new session.
 */
export const browserSessions = sqliteTable("browser_sessions", {
  agentId: text("agent_id").primaryKey(),
  /** Where the session was last left, for the right rail's status. */
  currentUrl: text("current_url"),
  sessionId: text("session_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type BrowserSession = typeof browserSessions.$inferSelect;

/**
 * A screenshot the agent took, stored in R2 under `browser/<agentId>/...`. The
 * bytes never go in D1; this row is the index the UI and the agent address them
 * by.
 */
export const browserScreenshots = sqliteTable(
  "browser_screenshots",
  {
    agentId: text("agent_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    /** The page the screenshot is of. */
    pageUrl: text("page_url").notNull(),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
    title: text("title").notNull().default(""),
  },
  (table) => [
    index("browser_screenshots_agent_created_idx").on(
      table.agentId,
      table.createdAt
    ),
  ]
);

export type BrowserScreenshot = typeof browserScreenshots.$inferSelect;
