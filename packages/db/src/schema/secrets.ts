import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { SECRET_MODES } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A workspace secret an agent can be granted (S.3). `value_enc` is AES-GCM
 * ciphertext under `SECRETS_KEY`: write-only, never selected into a response.
 * `rules` is a JSON array of `{ host, header, template }` and is `[]` for an
 * `env` secret. `allowed_hosts` is a JSON array of host patterns an `env`
 * secret's placeholder may be filled in for, and is `[]` for a `proxy` secret.
 * `version` counts value and rule changes, so a managed session
 * made under an older one is not reused.
 */
export const secrets = sqliteTable(
  "secrets",
  {
    // JSON array of host patterns, same pattern as a rule host.
    allowedHosts: text("allowed_hosts").notNull().default("[]"),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    id: id(),
    mode: text("mode", { enum: SECRET_MODES }).notNull(),
    // A validated environment variable name.
    name: text("name").notNull(),
    // JSON array, see `ruleSchema` in the secrets service.
    rules: text("rules").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
    // Encrypted. Never select this column into a response.
    valueEnc: text("value_enc").notNull(),
    version: integer("version").notNull().default(1),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("secrets_workspace_name_unique").on(t.workspaceId, t.name),
  ]
);

/** Which secrets an agent is granted. Grants are per agent, never per skill. */
export const agentSecrets = sqliteTable(
  "agent_secrets",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    createdAt: createdAt(),
    secretId: text("secret_id")
      .notNull()
      .references(() => secrets.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.secretId] })]
);
