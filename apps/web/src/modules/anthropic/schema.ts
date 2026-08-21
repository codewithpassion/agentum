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

/**
 * The cache entry for a workspace running on its own API key. An environment
 * belongs to the key that created it, so a workspace with its own key must not
 * read the deployment-wide entry - and deleting its key has to fall back to
 * `ENVIRONMENT_ID_KEY` rather than to a stale per-workspace id.
 */
export const environmentIdKeyFor = (workspaceId: string): string =>
  `${ENVIRONMENT_ID_KEY}:${workspaceId}`;

/**
 * A workspace's own Anthropic API key, encrypted with `CONNECTOR_KEY` the same
 * way connector secrets are. It lives here rather than on the `workspaces` row
 * for two reasons: the resolver that reads it is this module's, and a table of
 * its own means no `select *` on a workspace can ever carry ciphertext out.
 *
 * `workspace_id` carries no foreign key, following the same module-isolation
 * convention as every other table outside `modules/workspaces`.
 *
 * Write-only by design: `key_hint` (the last four characters) is computed when
 * the key is stored, so showing which key is configured never needs a decrypt.
 */
export const workspaceAnthropicKeys = sqliteTable("workspace_anthropic_keys", {
  apiKeyEnc: text("api_key_enc").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  keyHint: text("key_hint").notNull(),
  /** Audit only - never serialized to a client. */
  setByClerkUserId: text("set_by_clerk_user_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  workspaceId: text("workspace_id").primaryKey(),
});

export type WorkspaceAnthropicKey = typeof workspaceAnthropicKeys.$inferSelect;
