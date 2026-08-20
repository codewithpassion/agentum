import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * The bridge layer's mapping table: ties an external surface's identifier to
 * an internal channel/message/author. Slack is the first user - a Slack channel
 * id resolves to our channel, and a Slack `ts` to our message so replies thread
 * in both directions.
 */
export const externalRefs = sqliteTable(
  "external_refs",
  {
    /** e.g. `slack`. */
    connector: text("connector").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** e.g. a Slack channel id, message `ts`, or user id. */
    externalId: text("external_id").notNull(),
    id: text("id").primaryKey(),
    internalId: text("internal_id").notNull(),
    /** e.g. `channel`, `message`, `author`. */
    internalType: text("internal_type").notNull(),
  },
  (table) => [
    unique("external_refs_connector_external_idx").on(
      table.connector,
      table.internalType,
      table.externalId
    ),
    // Mirroring a threaded reply asks the reverse question - "what is this
    // internal message's Slack ts?" - so the reverse direction is indexed too.
    index("external_refs_internal_idx").on(
      table.connector,
      table.internalType,
      table.internalId
    ),
  ]
);

export const SLACK_APP_STATUSES = ["draft", "active", "error"] as const;

/**
 * One Slack app per agent: the agent's own bot user, its tokens, and the id
 * that appears in its events URL (`/api/bridges/slack/<id>`).
 *
 * The row is created `draft` - the manifest needs the events URL and the URL
 * needs the row id, so the id exists before any credential does. Tokens arrive
 * later, through the wizard's second step, and are AES-GCM encrypted with
 * `CONNECTOR_KEY` (see `#/crypto`); they are write-only, and no API response
 * ever returns them.
 *
 * `workspace_id` is the tenant boundary and carries no foreign key, for the
 * same reason `channel_bridges` has none: this module must not depend on
 * another module's tables.
 */
export const slackApps = sqliteTable(
  "slack_apps",
  {
    /** The agent this app speaks as - it *is* that agent inside Slack. */
    agentId: text("agent_id").notNull(),
    botTokenEnc: text("bot_token_enc"),
    /** `auth.test`'s `user_id`: the bot's own user id, for display. */
    botUserId: text("bot_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Appears in the events URL; unguessable, but not the credential. */
    id: text("id").primaryKey(),
    /** Why the last token verification failed, in Slack's own words. */
    lastError: text("last_error"),
    signingSecretEnc: text("signing_secret_enc"),
    status: text("status", { enum: SLACK_APP_STATUSES })
      .notNull()
      .default("draft"),
    teamId: text("team_id"),
    teamName: text("team_name"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    // One app per agent: that one-to-one is the whole point of the feature.
    unique("slack_apps_agent_idx").on(table.agentId),
    index("slack_apps_workspace_idx").on(table.workspaceId),
  ]
);

export const BRIDGE_STATUSES = ["active", "disabled"] as const;

/**
 * A channel bridged to an external surface. `agent_id` is the agent the bot
 * account speaks as: an inbound `<@BOTID>` mention is rewritten to that agent's
 * `@Name`, which is what makes a Slack mention wake the agent.
 *
 * `workspace_id` is the tenant boundary, and carries no foreign key to
 * `workspaces` - this module must not depend on another module's tables. It
 * matters more here than anywhere else: an inbound Slack event is not
 * Clerk-authed, so the bridge row is the only thing that maps it to a
 * workspace. `external_refs`, `slack_users` and `slack_events_seen` are
 * bridge-scoped lookups and get no column of their own.
 */
export const channelBridges = sqliteTable(
  "channel_bridges",
  {
    agentId: text("agent_id"),
    channelId: text("channel_id").notNull(),
    /** e.g. `slack`. */
    connector: text("connector").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    externalChannelId: text("external_channel_id").notNull(),
    id: text("id").primaryKey(),
    /**
     * The Slack app this bridge belongs to. An inbound event is only processed
     * when it arrived for *this* app - two connected bots sitting in the same
     * Slack channel both receive it, and only its owner may act on it.
     */
    slackAppId: text("slack_app_id").notNull(),
    status: text("status", { enum: BRIDGE_STATUSES })
      .notNull()
      .default("active"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    // One bridge per channel per connector, and one connector channel is never
    // bridged twice - otherwise an inbound event has no single destination.
    unique("channel_bridges_channel_idx").on(table.channelId, table.connector),
    unique("channel_bridges_external_idx").on(
      table.connector,
      table.externalChannelId
    ),
    // Neither unique above leads with the workspace, so the "this workspace's
    // bridges" reads - the agent rail's card, and the delete cleanup - need one.
    index("channel_bridges_workspace_idx").on(table.workspaceId),
  ]
);

/**
 * Slack retries deliveries it thinks failed, and a channel message the bot is
 * mentioned in arrives twice (`message` and `app_mention`) with different
 * event ids. This table claims an event id before any work happens; the
 * message-level `external_refs` entry catches the second case.
 *
 * Rows are only useful for Slack's retry window - pruning is a later concern.
 */
export const slackEventsSeen = sqliteTable("slack_events_seen", {
  eventId: text("event_id").primaryKey(),
  seenAt: integer("seen_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/** Display names for `slack:U…` authors, fetched lazily via `users.info`. */
export const slackUsers = sqliteTable("slack_users", {
  displayName: text("display_name").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  userId: text("user_id").primaryKey(),
});

export type ExternalRef = typeof externalRefs.$inferSelect;
export type ChannelBridge = typeof channelBridges.$inferSelect;
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];
export type SlackApp = typeof slackApps.$inferSelect;
export type SlackAppStatus = (typeof SLACK_APP_STATUSES)[number];
