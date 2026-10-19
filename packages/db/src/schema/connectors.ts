import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  CONNECTOR_AUTH_KINDS,
  CONNECTOR_CALL_TIMEOUT_SECONDS,
  CONNECTOR_STATUSES,
  CREDENTIAL_MODES,
  CREDENTIAL_OWNER_KINDS,
  CREDENTIAL_STATUSES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * An MCP server the access lane can call. `tools` is a JSON array of
 * `{ name, description }`. `oauth` is JSON (the discovered endpoints, scope and
 * client), written by the OAuth connect flow.
 */
export const connectors = sqliteTable(
  "connectors",
  {
    authKind: text("auth_kind", { enum: CONNECTOR_AUTH_KINDS }).notNull(),
    // Seconds a connector tool call may take before it is stopped.
    callTimeoutSeconds: integer("call_timeout_seconds")
      .notNull()
      .default(CONNECTOR_CALL_TIMEOUT_SECONDS.default),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    headerName: text("header_name"),
    id: id(),
    name: text("name").notNull(),
    // JSON, see `OAuthConfig` in the connectors service.
    oauth: text("oauth"),
    status: text("status", { enum: CONNECTOR_STATUSES }).notNull(),
    // JSON array of `{ name, description }`.
    tools: text("tools").notNull().default("[]"),
    toolsFetchedAt: text("tools_fetched_at"),
    url: text("url").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("connectors_workspace_idx").on(t.workspaceId)]
);

/**
 * A stored login for one connector, owned by a user or an agent. `secret` is
 * AES-GCM ciphertext. It is encrypted and must never be selected into a
 * response.
 */
export const credentials = sqliteTable(
  "credentials",
  {
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at"),
    id: id(),
    ownerId: text("owner_id").notNull(),
    ownerKind: text("owner_kind", { enum: CREDENTIAL_OWNER_KINDS }).notNull(),
    refreshingUntil: text("refreshing_until"),
    scopes: text("scopes"),
    // Encrypted. Never select this column into a response.
    secret: text("secret").notNull(),
    status: text("status", { enum: CREDENTIAL_STATUSES })
      .notNull()
      .default("ok"),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("credentials_owner_unique").on(
      t.connectorId,
      t.ownerKind,
      t.ownerId
    ),
  ]
);

/** Which connectors an agent may call, and whose credential it uses. */
export const agentConnectors = sqliteTable(
  "agent_connectors",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    createdAt: createdAt(),
    credentialMode: text("credential_mode", { enum: CREDENTIAL_MODES })
      .notNull()
      .default("user_or_agent"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectorId] })]
);

/**
 * An OAuth authorisation in flight: PKCE, bound to the signed-in user who
 * clicked Connect. `state` is the one-shot value sent to the provider. The
 * callback deletes the row before it does anything else, so a state works once.
 * The minute tick purges rows past `expires_at`.
 */
export const oauthStates = sqliteTable(
  "oauth_states",
  {
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
    // Clerk user id of the person who clicked Connect.
    initiatorUserId: text("initiator_user_id").notNull(),
    // The credential owner: the initiator for `user`, an agent id for `agent`.
    ownerId: text("owner_id").notNull(),
    ownerKind: text("owner_kind", { enum: CREDENTIAL_OWNER_KINDS }).notNull(),
    // Sent to the provider; must be sent again byte for byte at the token call.
    redirectUri: text("redirect_uri").notNull(),
    // A same-origin path.
    returnTo: text("return_to").notNull(),
    state: text("state").primaryKey(),
    // The PKCE verifier. Single use, minutes long, useless without the state.
    verifier: text("verifier").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("oauth_states_expires_idx").on(t.expiresAt)]
);
