import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * A user-added remote MCP server. Two credential stores hang off one row, and
 * the split is deliberate (see docs/plan-connectors-skills.md, 4a):
 *
 * - the **vault credential** (`vaultId` / `vaultCredentialId`) is what Anthropic
 *   injects into sessions and refreshes on its own. We never see the refreshed
 *   token, and never write ours back except on an explicit re-authorization.
 * - the **encrypted copy** (`mgmt*`) is the management plane only: listing tools
 *   for the UI and "Test connection". If the server rotates refresh tokens,
 *   Anthropic's refresh can invalidate our copy - that degrades to `mgmtError`
 *   while `status` (and every running session) stays untouched.
 */

/** How the connector stands for *sessions* - never set by a management failure. */
export const CONNECTOR_STATUSES = [
  "unconfigured",
  "authorizing",
  "connected",
  "auth_error",
  "disabled",
] as const;

/** What the server asked us for, decided by the probe ladder in `oauth.ts`. */
export const CONNECTOR_AUTH_KINDS = ["none", "oauth", "bearer"] as const;

/** How the token endpoint wants the client to identify itself (RFC 6749 §2.3). */
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;

export const connectors = sqliteTable("connectors", {
  authKind: text("auth_kind", { enum: CONNECTOR_AUTH_KINDS })
    .notNull()
    .default("none"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  /** Why the connector last failed *for sessions*; cleared on a good probe. */
  lastError: text("last_error"),
  mgmtAccessTokenEnc: text("mgmt_access_token_enc"),
  /**
   * Why the management copy stopped working - typically a refresh token the
   * server rotated out from under us. Deliberately separate from `lastError`:
   * this one must never change `status`, because sessions are unaffected.
   */
  mgmtError: text("mgmt_error"),
  mgmtExpiresAt: integer("mgmt_expires_at", { mode: "timestamp_ms" }),
  mgmtRefreshTokenEnc: text("mgmt_refresh_token_enc"),
  name: text("name").notNull(),
  /** Discovered by dynamic registration, or typed in by the human. */
  oauthClientId: text("oauth_client_id"),
  oauthClientSecretEnc: text("oauth_client_secret_enc"),
  oauthTokenEndpoint: text("oauth_token_endpoint"),
  /**
   * Needed at refresh time, so it is stored rather than guessed from whether a
   * secret is present - a confidential client may still want `client_secret_post`.
   */
  oauthTokenEndpointAuth: text("oauth_token_endpoint_auth", {
    enum: TOKEN_ENDPOINT_AUTH_METHODS,
  }),
  status: text("status", { enum: CONNECTOR_STATUSES })
    .notNull()
    .default("unconfigured"),
  /** `{ fetchedAt, tools: [{ name, description }] }`, last successful listing. */
  toolCache: text("tool_cache", { mode: "json" }).$type<ToolCache>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  /** Canonical MCP endpoint. Unique: one vault, one credential, one row per URL. */
  url: text("url").notNull().unique(),
  vaultCredentialId: text("vault_credential_id"),
  /** One vault per connector - see the topology note in the plan (4a). */
  vaultId: text("vault_id"),
});

/**
 * Which agents may use which connector. The assignment is what puts the
 * connector's vault on that agent's next session.
 */
export const agentConnectors = sqliteTable(
  "agent_connectors",
  {
    agentId: text("agent_id").notNull(),
    connectorId: text("connector_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
  },
  (table) => [
    unique("agent_connectors_pair_idx").on(table.agentId, table.connectorId),
  ]
);

/**
 * The in-flight authorization-code flow. `connectorId` is the primary key,
 * which is what enforces "one active flow per connector": starting a new one
 * overwrites the old, and consuming it deletes the row so a `state` is
 * single-use.
 */
export const connectorOauthFlows = sqliteTable("connector_oauth_flows", {
  connectorId: text("connector_id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  /** Must match at the callback, byte for byte, before any code is exchanged. */
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope"),
  state: text("state").notNull().unique(),
  /**
   * The PKCE verifier. Not encrypted: it is single-use, expires in minutes, and
   * is worthless without the matching `state` this table also holds.
   */
  verifier: text("verifier").notNull(),
});

export interface CachedTool {
  description: string | null;
  name: string;
}

export interface ToolCache {
  fetchedAt: number;
  tools: CachedTool[];
}

export type Connector = typeof connectors.$inferSelect;
export type AgentConnector = typeof agentConnectors.$inferSelect;
export type ConnectorOauthFlow = typeof connectorOauthFlows.$inferSelect;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];
export type TokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];
