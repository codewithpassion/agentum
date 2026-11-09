import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { LIVE_RUN_STATUS_LITERALS, RUN_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { artifacts } from "./artifacts.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Claim, heartbeat and complete are compare-and-set updates (WHERE status = ?).
 * An expired lease makes a run `interrupted`; it is never re-queued. JSON
 * columns hold a zod-validated shape owned by the module that writes them.
 */
export const runs = sqliteTable(
  "runs",
  {
    // Snapshot of the access a subagent inherits, narrowed by its caller. JSON.
    accessScope: text("access_scope"),
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // When a person dismissed this run from Needs you, and who.
    attentionClearedAt: text("attention_cleared_at"),
    // Clerk user id.
    attentionClearedBy: text("attention_cleared_by"),
    claimedBy: text("claimed_by"),
    createdAt: createdAt(),
    depth: integer("depth").notNull().default(0),
    // A dry run reads and thinks but skips every write, and records what it
    // would have done as `run.dry_run_skipped` events.
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    finishedAt: text("finished_at"),
    id: id(),
    // JSON array of file ids.
    inputFileIds: text("input_file_ids").notNull().default("[]"),
    inputText: text("input_text").notNull(),
    leaseUntil: text("lease_until"),
    model: text("model"),
    onBehalfOfUserId: text("on_behalf_of_user_id"),
    // JSON array of output file ids.
    outputFileIds: text("output_file_ids").notNull().default("[]"),
    parentRunId: text("parent_run_id").references(
      (): AnySQLiteColumn => runs.id
    ),
    // Downloads of pending_files that failed. Three failures fail the run.
    pendingAttempts: integer("pending_attempts").notNull().default(0),
    // Slack file descriptors not yet in R2. A run with pending files is not
    // claimable. JSON.
    pendingFiles: text("pending_files"),
    processEndedAt: text("process_ended_at"),
    // JSON.
    reply: text("reply"),
    requestId: text("request_id"),
    resultText: text("result_text"),
    scopeArtifactId: text("scope_artifact_id").references(
      (): AnySQLiteColumn => artifacts.id
    ),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    // The Slack working status of a run that replies in Slack: when and what
    // was last claimed (the 5 s limit rests on these, so it holds across
    // requests), and whether no more are sent (a call failed, or the run failed,
    // was cancelled or was interrupted).
    slackStatusAt: text("slack_status_at"),
    slackStatusLabel: text("slack_status_label"),
    slackStatusStopped: integer("slack_status_stopped", { mode: "boolean" })
      .notNull()
      .default(false),
    startedAt: text("started_at"),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    subagentLevel: integer("subagent_level").notNull().default(0),
    // Written only by the queued-run sweep: when it last looked at the run.
    sweptAt: text("swept_at"),
    // JSON.
    usage: text("usage"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("runs_request_unique").on(t.workspaceId, t.requestId),
    // The runs of one actor in time order, which is how a routine's runs are found.
    index("runs_parent_idx").on(t.parentRunId),
    index("runs_actor_idx").on(t.actorId, t.id),
    index("runs_guest_daily_idx").on(
      t.workspaceId,
      t.actorKind,
      t.actorId,
      t.createdAt
    ),
    // The desk's lanes and agent filter, the queued-run sweep and `claimRun`.
    index("runs_workspace_status_idx").on(t.workspaceId, t.status),
    index("runs_workspace_finished_idx").on(t.workspaceId, t.finishedAt),
    index("runs_agent_status_idx").on(t.agentId, t.status),
    // The live runs of every workspace, which the revoke sweep reads each
    // minute. Live runs are few next to all of them.
    index("runs_live_status_idx")
      .on(t.status)
      .where(sql`${t.status} in (${sql.raw(LIVE_RUN_STATUS_LITERALS)})`),
  ]
);
