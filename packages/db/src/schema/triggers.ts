import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";

/**
 * Stub from M0.1 so the principal resolver can read hm_trg_ tokens. M4.1
 * replaces this table with the full triggers table in its own migration.
 */
export const triggers = sqliteTable(
  "triggers",
  {
    agentId: text("agent_id").notNull(),
    createdAt: createdAt(),
    id: id(),
    tokenHash: text("token_hash").notNull(),
    workspaceId: workspaceId(),
  },
  (t) => [uniqueIndex("triggers_token_hash_unique").on(t.tokenHash)]
);
