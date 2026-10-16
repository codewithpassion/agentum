import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { API_KEY_ACCESS } from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Stub from M0.1 so the principal resolver can read hm_key_ tokens. M2.1 adds
 * the service and the settings page on top of it.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    access: text("access", { enum: API_KEY_ACCESS }).notNull(),
    createdAt: createdAt(),
    // Clerk user id who minted the key.
    createdBy: text("created_by").notNull(),
    id: id(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: text("last_used_at"),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    revokedAt: text("revoked_at"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [uniqueIndex("api_keys_hash_unique").on(t.keyHash)]
);
