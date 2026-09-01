import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * `workspace_id` is the tenant boundary and carries no foreign key to
 * `workspaces`: this module owns its schema and must not depend on another
 * module's tables. An agent's children - its activity, connector and skill
 * assignments, browser session - inherit tenancy through `agent_id` and get no
 * column of their own.
 */

/** How the agent's registration with the Anthropic API stands. */
export const AGENT_SYNC_STATUSES = ["unregistered", "synced", "error"] as const;

/** What the agent is doing right now, as the router sees it. */
export const AGENT_STATUSES = ["idle", "queued", "working", "error"] as const;

/**
 * Where the agent's loop runs. `managed` is Anthropic's Managed Agents (a
 * registered agent, cloud sessions, the sandbox toolset); `cloudflare` is our
 * own loop in a Durable Object, talking to a model on Workers AI or through AI
 * Gateway, with the same workspace tools called in-process. Fixed at creation:
 * the two keep incompatible session state.
 */
export const AGENT_RUNTIMES = ["managed", "cloudflare"] as const;

export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const isAgentRuntime = (value: unknown): value is AgentRuntime =>
  typeof value === "string" &&
  (AGENT_RUNTIMES as readonly string[]).includes(value);

export const agents = sqliteTable(
  "agents",
  {
    /** Set in phase 2, when the agent is registered with the Anthropic API. */
    anthropicAgentId: text("anthropic_agent_id"),
    /** Avatar seed - a hex colour picked deterministically from the name. */
    avatar: text("avatar").notNull(),
    /**
     * When a connector change asked for a token rotation and a full `mcp_servers`
     * resync; null when nothing is owed. The rotation waits until the agent has
     * no session (see `sessionId`), because it invalidates the workspace MCP URL
     * a running session is holding.
     */
    connectorResyncPendingAt: integer("connector_resync_pending_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    instructions: text("instructions").notNull().default(""),
    /**
     * SHA-256 of the per-agent secret embedded in its MCP server URL. The token
     * itself is never stored: it is returned once, when issued or rotated.
     *
     * Globally unique, unlike the name: it is a credential lookup key, resolved
     * before any workspace is known.
     */
    mcpTokenHash: text("mcp_token_hash").unique(),
    memoryStoreId: text("memory_store_id"),
    /**
     * A model id; null means the runtime's default. For `managed` it is a
     * catalog id (`AVAILABLE_MODELS`); for `cloudflare` a Workers AI model
     * (`@cf/...`) or an AI Gateway `{provider}/{model}` reference.
     */
    model: text("model"),
    /** Unique within the workspace only - see the index below. */
    name: text("name").notNull(),
    runtime: text("runtime", { enum: AGENT_RUNTIMES })
      .notNull()
      .default("managed"),
    /** The Anthropic session the router is currently driving, if any. */
    sessionId: text("session_id"),
    soul: text("soul").notNull().default(""),
    status: text("status", { enum: AGENT_STATUSES }).notNull().default("idle"),
    /** Why the last registration attempt failed; null unless `syncStatus` is "error". */
    syncError: text("sync_error"),
    syncStatus: text("sync_status", { enum: AGENT_SYNC_STATUSES })
      .notNull()
      .default("unregistered"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    unique("agents_workspace_name_idx").on(table.workspaceId, table.name),
  ]
);

/**
 * "Run this agent on that model in this conversation." One row per override,
 * addressed by the conversation it applies to: a thread, or - with the `''`
 * sentinel in `thread_parent_id` - a whole channel.
 *
 * The sentinel is not NULL on purpose. SQLite treats NULLs as distinct in a
 * unique index, so a nullable column would let a channel collect any number of
 * channel-level rows for the same agent.
 */
export const agentModelOverrides = sqliteTable(
  "agent_model_overrides",
  {
    agentId: text("agent_id").notNull(),
    channelId: text("channel_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Who set it: `"agent:<id>"` or `"routine:<id>"`. */
    createdBy: text("created_by").notNull(),
    id: text("id").primaryKey(),
    /** A catalog model id. */
    model: text("model").notNull(),
    /** `''` for a channel-level override - see above. */
    threadParentId: text("thread_parent_id").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    unique("agent_model_overrides_scope_idx").on(
      table.agentId,
      table.channelId,
      table.threadParentId
    ),
    index("agent_model_overrides_workspace_idx").on(table.workspaceId),
  ]
);

export type Agent = typeof agents.$inferSelect;
export type AgentModelOverride = typeof agentModelOverrides.$inferSelect;
