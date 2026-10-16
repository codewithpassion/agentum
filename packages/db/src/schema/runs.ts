import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { RUN_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
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
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    claimedBy: text("claimed_by"),
    createdAt: createdAt(),
    depth: integer("depth").notNull().default(0),
    error: text("error"),
    finishedAt: text("finished_at"),
    id: id(),
    // JSON array of file ids.
    inputFileIds: text("input_file_ids").notNull().default("[]"),
    inputText: text("input_text").notNull(),
    leaseUntil: text("lease_until"),
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
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    startedAt: text("started_at"),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    // JSON.
    usage: text("usage"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("runs_request_unique").on(t.workspaceId, t.requestId)]
);
