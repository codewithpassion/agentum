import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A tiny key-value table for state that belongs to the deployment rather than
 * to any row: currently just the id of the shared Anthropic environment, which
 * is expensive to rediscover (a full list call) and must not be recreated -
 * duplicates would eat the five concurrent-environment slots.
 */
export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  value: text("value").notNull(),
});

export const ENVIRONMENT_ID_KEY = "anthropic.environment_id";
