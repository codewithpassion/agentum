import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { TRIGGER_KINDS } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Ways to start one agent from outside or on a clock. An `http` trigger holds
 * the SHA-256 of its `hm_trg_` token and nothing else, so the secret cannot be
 * read back. A `routine` has no token; it holds a cron, a timezone, a prompt
 * and the next slot to fire (`next_run_at`, an ISO instant). The tick fires it
 * and moves `next_run_at` in one atomic write with the run. A routine switches
 * itself off (`disabled_at`) after 5 errors in a row. A revoked row stays, so
 * the log can still name it.
 */
export const triggers = sqliteTable(
  "triggers",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // When a person approved the proposal. A proposal with this null is
    // pending: it is disabled, and an `http` one has no token yet.
    approvedAt: text("approved_at"),
    // Routine only. Consecutive failures since the last good run.
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    createdAt: createdAt(),
    // Clerk user id who made the trigger, or the run id when a run proposed it.
    createdBy: text("created_by").notNull(),
    // Routine only. Five-field cron, read in `timezone`.
    cron: text("cron"),
    // Set when the trigger is paused, switched off by errors (routine) or still
    // waiting for approval. A disabled trigger never fires.
    disabledAt: text("disabled_at"),
    id: id(),
    kind: text("kind", { enum: TRIGGER_KINDS }).notNull(),
    lastError: text("last_error"),
    lastFiredAt: text("last_fired_at"),
    name: text("name").notNull(),
    // Routine only. The slot the tick fires next.
    nextRunAt: text("next_run_at"),
    // Routine only. The run's input text.
    prompt: text("prompt"),
    // Set when an agent's run proposed this trigger. Null for one a person made.
    proposedByAgentId: text("proposed_by_agent_id"),
    proposedByRunId: text("proposed_by_run_id"),
    revokedAt: text("revoked_at"),
    // Routine only. The last run counted into `consecutive_errors`. Run ids
    // sort by time, so the runs after it are the ones still to judge.
    settledRunId: text("settled_run_id"),
    // Routine only. IANA zone, copied from the workspace when not given.
    timezone: text("timezone"),
    // Null for a routine, and for an `http` proposal until it is approved.
    tokenHash: text("token_hash"),
    // The start of the token, so triggers can be told apart in a list.
    tokenPrefix: text("token_prefix"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("triggers_token_hash_unique").on(t.tokenHash),
    index("triggers_due_idx").on(t.nextRunAt),
  ]
);
