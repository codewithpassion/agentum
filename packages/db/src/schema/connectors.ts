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
  CONNECTOR_STATUSES,
  CREDENTIAL_MODES,
  CREDENTIAL_OWNER_KINDS,
  CREDENTIAL_STATUSES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * An MCP server the access lane can call. `tools` is a JSON array of
 * `{ name, description }`. `oauth` is JSON, filled by the OAuth task.
 */
export const connectors = sqliteTable(
  "connectors",
  {
    authKind: text("auth_kind", { enum: CONNECTOR_AUTH_KINDS }).notNull(),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    headerName: text("header_name"),
    id: id(),
    name: text("name").notNull(),
    // JSON, owned by the OAuth task.
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
