import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * The connector layer's mapping table: ties an external surface's identifier to
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

export const BRIDGE_STATUSES = ["active", "disabled"] as const;

/**
 * A channel bridged to an external surface. `agent_id` is the agent the bot
 * account speaks as: an inbound `<@BOTID>` mention is rewritten to that agent's
 * `@Name`, which is what makes a Slack mention wake the agent.
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
    status: text("status", { enum: BRIDGE_STATUSES })
      .notNull()
      .default("active"),
  },
  (table) => [
    // One bridge per channel per connector, and one connector channel is never
    // bridged twice - otherwise an inbound event has no single destination.
    unique("channel_bridges_channel_idx").on(table.channelId, table.connector),
    unique("channel_bridges_external_idx").on(
      table.connector,
      table.externalChannelId
    ),
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
