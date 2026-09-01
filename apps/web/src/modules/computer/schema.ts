import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Where an agent's computer runs when it is not the Cloudflare Durable Object:
 * one row per Fly app or per self-hosted machine (see
 * docs/plan-computer-backends.md §3).
 *
 * `workspace_id` is the tenant boundary and carries no foreign key to
 * `workspaces`: this module owns its schema and must not depend on another
 * module's tables. The agents that sit on a host point at it from their own
 * row (`agents.computer_host_id`), so nothing here needs a join table.
 */

/** Which of the two remote backends this host is. */
export const COMPUTER_HOST_KINDS = ["fly", "self_hosted"] as const;

export type ComputerHostKind = (typeof COMPUTER_HOST_KINDS)[number];

export const isComputerHostKind = (value: unknown): value is ComputerHostKind =>
  typeof value === "string" &&
  (COMPUTER_HOST_KINDS as readonly string[]).includes(value);

/**
 * How the host stands, as of the last ping, connect or heartbeat.
 * `unconfigured` is the state a fresh host - or a freshly rotated token - is
 * in until something has actually talked to the daemon.
 */
export const COMPUTER_HOST_STATUSES = [
  "unconfigured",
  "ready",
  "error",
  "offline",
] as const;

export type ComputerHostStatus = (typeof COMPUTER_HOST_STATUSES)[number];

/**
 * A Fly host's machine settings, in the shapes the Machines API wants them -
 * `memory_mb` and `volume_gb` are sent on verbatim by the Fly gateway, so they
 * keep Fly's spelling rather than being translated twice. Self-hosted hosts
 * store `{}`: the container is the user's to configure.
 */
export interface ComputerHostConfig {
  /** The Fly app the machines live in. Required for `fly`, absent otherwise. */
  app?: string;
  image?: string;
  instance?: { cpus?: number; memory_mb?: number };
  region?: string;
  volume_gb?: number;
}

export const computerHosts = sqliteTable(
  "computer_hosts",
  {
    /**
     * Fly: `{ app, region, image, instance, volume_gb }`.
     * Self-hosted: `{}`.
     */
    config: text("config", { mode: "json" })
      .notNull()
      .$type<ComputerHostConfig>()
      .default({}),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /**
     * Fly only: the user's Fly API token (a deploy token scoped to the app),
     * `encryptSecret`-ed under `CONNECTOR_KEY`. Write-only - it leaves the
     * server as `flyApiTokenHint` and nothing else.
     */
    flyApiTokenEnc: text("fly_api_token_enc"),
    /** The token's last four characters, the way the Anthropic key is hinted. */
    flyApiTokenHint: text("fly_api_token_hint"),
    id: text("id").primaryKey(),
    /** Fixed at creation: the two kinds store different credentials. */
    kind: text("kind", { enum: COMPUTER_HOST_KINDS }).notNull(),
    /** Connect mode: last heartbeat. Listen mode: last successful ping. */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    /** Unique within the workspace only - see the index below. */
    name: text("name").notNull(),
    status: text("status", { enum: COMPUTER_HOST_STATUSES })
      .notNull()
      .default("unconfigured"),
    /** Why the last ping or connect failed; null unless `status` is "error". */
    statusError: text("status_error"),
    /**
     * Fly only: the daemon token in plaintext-under-encryption, because here
     * Agentum is the *client* presenting it on every request. The user never
     * sees it; only `resolveHostToken` decrypts it.
     */
    tokenEnc: text("token_enc"),
    /**
     * Self-hosted only: SHA-256 of the token the daemon dials in with. The
     * plaintext exists once, in the create/rotate response.
     *
     * Globally unique, unlike the name: it is a credential lookup key, resolved
     * before any workspace is known - exactly like `agents.mcp_token_hash`.
     */
    tokenHash: text("token_hash").unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    unique("computer_hosts_workspace_name_idx").on(
      table.workspaceId,
      table.name
    ),
  ]
);

export type ComputerHost = typeof computerHosts.$inferSelect;
