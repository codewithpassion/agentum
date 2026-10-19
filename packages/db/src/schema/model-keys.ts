import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, workspaceId } from "../columns.ts";
import { MODEL_PROVIDERS } from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A workspace's own key for a model provider, encrypted with `SECRETS_KEY`.
 * Write-only: the UI sees `key_hint`, the last four characters. Never selected
 * into a response. Kept apart from `workspace_anthropic_keys` because changing
 * it must not clear Managed Agents state.
 */
export const workspaceModelKeys = sqliteTable(
  "workspace_model_keys",
  {
    apiKeyEnc: text("api_key_enc").notNull(),
    createdAt: createdAt(),
    keyHint: text("key_hint").notNull(),
    provider: text("provider", { enum: MODEL_PROVIDERS }).notNull(),
    // Clerk user who set the key. Audit only.
    setBy: text("set_by").notNull(),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })]
);
