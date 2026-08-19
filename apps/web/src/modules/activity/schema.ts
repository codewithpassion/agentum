import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * What an agent did, in one flat table the right rail replays. `agent_id`
 * carries no foreign key on purpose: this module is written to by the computer
 * module today and the browser and wiki modules next, and none of them may
 * depend on another module's tables.
 *
 * `kind` is deliberately open at the schema level (plain text) but closed in
 * TypeScript, so a new capability adds a member here without a migration.
 */

export const ACTIVITY_KINDS = [
  "browser.click",
  "browser.fill",
  "browser.navigate",
  "browser.screenshot",
  "computer.delete",
  "computer.edit",
  "computer.exec",
  "computer.write",
  "wiki.edit",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Free-form per-kind payload: command, exit code, truncated output, file path. */
export type ActivityDetail = Record<string, unknown>;

export const agentActivity = sqliteTable(
  "agent_activity",
  {
    agentId: text("agent_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    detail: text("detail", { mode: "json" }).$type<ActivityDetail>(),
    id: text("id").primaryKey(),
    kind: text("kind").$type<ActivityKind>().notNull(),
    /** One line, already human-readable: the UI never has to parse `detail`. */
    summary: text("summary").notNull(),
  },
  (table) => [
    index("agent_activity_agent_created_idx").on(
      table.agentId,
      table.createdAt
    ),
  ]
);

export type AgentActivity = typeof agentActivity.$inferSelect;
