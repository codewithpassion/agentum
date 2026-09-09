import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * A workspace's own API keys for third-party services, and which agents may
 * use them.
 *
 * The row is the source of truth and the value is write-only from the outside:
 * it goes in encrypted (AES-GCM under `CONNECTOR_KEY`, with `workspace_id:id`
 * as additional authenticated data, so a ciphertext copied into another row
 * fails to decrypt) and it comes back out as four characters. Two functions
 * decrypt it - the tool path and the vault mirror - and neither is a route
 * handler.
 *
 * `workspace_id` is the tenant boundary and carries no foreign key, following
 * the same module-isolation convention as every other table outside
 * `modules/workspaces`. `agent_secrets` joins two rows that already carry a
 * tenant, so it gets no column of its own - exactly like `agent_connectors`.
 */

/**
 * How the vault mirror stands for this secret. The same three states an agent's
 * registration uses, and for the same reason: a mirror that has never been
 * pushed is not a mirror that failed.
 */
export const SECRET_SYNC_STATUSES = [
  "unregistered",
  "synced",
  "error",
] as const;

/** What precedes the value in the header, unless the owner says otherwise. */
export const DEFAULT_SECRET_HEADER = "Authorization";
export const DEFAULT_SECRET_HEADER_PREFIX = "Bearer ";

export const workspaceSecrets = sqliteTable(
  "workspace_secrets",
  {
    /**
     * Where this secret may be sent - exact hostnames or `*.example.com`, at
     * most 16 (Anthropic's cap on a vault credential's networking list). Empty
     * means *nowhere*, never "anywhere": the allowlist is the real control, and
     * a secret with no hosts is one no request can carry.
     */
    allowedHosts: text("allowed_hosts", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Shown to agents so they know what the secret is for. */
    description: text("description").notNull().default(""),
    /** The request header the value is injected into. */
    header: text("header").notNull().default(DEFAULT_SECRET_HEADER),
    /** `Token ` for Deepgram, empty for an `x-api-key`-style header. */
    headerPrefix: text("header_prefix")
      .notNull()
      .default(DEFAULT_SECRET_HEADER_PREFIX),
    /** The last four characters, computed at write time so a read never decrypts. */
    hint: text("hint").notNull(),
    id: text("id").primaryKey(),
    /**
     * Which `CONNECTOR_KEY` encrypted this row. No rotation tooling yet - the
     * column exists so a later script can tell re-encrypted rows from the rest.
     */
    keyVersion: integer("key_version").notNull().default(1),
    /** Bumped by the tool path. The audit trail for "was this key ever used?". */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /**
     * Env-var style, `^[A-Z][A-Z0-9_]{1,63}$`, unique within the workspace.
     * Immutable once set: the tool and the sandbox both key on it.
     */
    name: text("name").notNull(),
    /** Audit only - never serialized to a client. */
    setByClerkUserId: text("set_by_clerk_user_id").notNull(),
    /** Why the last mirror push failed; null unless `syncStatus` is "error". */
    syncError: text("sync_error"),
    syncStatus: text("sync_status", { enum: SECRET_SYNC_STATUSES })
      .notNull()
      .default("unregistered"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    valueEnc: text("value_enc").notNull(),
    /** The mirrored `environment_variable` credential in the workspace's vault. */
    vaultCredentialId: text("vault_credential_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    unique("workspace_secrets_workspace_name_idx").on(
      table.workspaceId,
      table.name
    ),
  ]
);

/**
 * Which agents may use which secret. The grant is what the tool path checks,
 * and what puts the workspace's secrets vault on a managed agent's next
 * session.
 */
export const agentSecrets = sqliteTable(
  "agent_secrets",
  {
    agentId: text("agent_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    secretId: text("secret_id").notNull(),
  },
  (table) => [
    unique("agent_secrets_pair_idx").on(table.agentId, table.secretId),
  ]
);

export type WorkspaceSecret = typeof workspaceSecrets.$inferSelect;
export type AgentSecret = typeof agentSecrets.$inferSelect;
export type SecretSyncStatus = (typeof SECRET_SYNC_STATUSES)[number];
