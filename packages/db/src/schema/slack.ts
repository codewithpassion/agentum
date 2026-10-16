import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { SLACK_APP_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

/**
 * One Slack app per agent and Slack workspace. `signing_secret`, `bot_token`
 * and `client_secret` are AES-GCM ciphertext (`crypto.ts`) and must never be
 * selected into a response. `app_id` is Slack's `api_app_id`, the key the
 * events route looks the row up by, so it is unique across workspaces.
 */
export const slackApps = sqliteTable(
  "slack_apps",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    appId: text("app_id").notNull(),
    botToken: text("bot_token"),
    botUserId: text("bot_user_id").notNull(),
    clientId: text("client_id"),
    clientSecret: text("client_secret"),
    createdAt: createdAt(),
    id: id(),
    signingSecret: text("signing_secret").notNull(),
    status: text("status", { enum: SLACK_APP_STATUSES }).notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("slack_apps_app_unique").on(t.appId),
    uniqueIndex("slack_apps_agent_team_unique").on(t.agentId, t.teamId),
  ]
);

/**
 * Dedupe of Slack retries. A row is written in the same atomic write as the
 * run it admitted (`run_id` null when the sender was unlinked), before the
 * 200. `event_hash` is a SHA-256 of the app id and event id. The minute tick
 * trims old rows.
 */
export const slackEventsSeen = sqliteTable(
  "slack_events_seen",
  {
    eventHash: text("event_hash").notNull(),
    id: id(),
    receivedAt: text("received_at").notNull(),
    runId: text("run_id").references(() => runs.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("slack_events_seen_hash_unique").on(t.eventHash)]
);
