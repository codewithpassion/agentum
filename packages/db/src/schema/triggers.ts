import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { TRIGGER_KINDS } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Ways to start one agent from outside. An `http` trigger holds the SHA-256
 * of its `hm_trg_` token and nothing else, so the secret cannot be read back.
 * A revoked row stays, so the log can still name it.
 */
export const triggers = sqliteTable(
  "triggers",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    // Clerk user id who made the trigger.
    createdBy: text("created_by").notNull(),
    id: id(),
    kind: text("kind", { enum: TRIGGER_KINDS }).notNull(),
    lastFiredAt: text("last_fired_at"),
    name: text("name").notNull(),
    revokedAt: text("revoked_at"),
    tokenHash: text("token_hash").notNull(),
    // The start of the token, so triggers can be told apart in a list.
    tokenPrefix: text("token_prefix").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [uniqueIndex("triggers_token_hash_unique").on(t.tokenHash)]
);
