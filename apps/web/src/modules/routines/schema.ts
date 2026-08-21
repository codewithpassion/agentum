import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A routine: instructions for one agent plus a schedule. When it fires, the
 * instructions are posted into the target channel mentioning the agent, and the
 * existing mention -> router -> wake path does the rest (docs/plan-routines.md).
 *
 * `routines.workspace_id` is the tenant boundary and carries no foreign key to
 * `workspaces` - this module must not depend on another module's tables, and
 * `agent_id` / `channel_id` are plain text for the same reason. It is the only
 * workspace column here: `routine_runs` inherits tenancy through its routine.
 *
 * `next_run_at` is derived from `schedule` (see `schedule.ts`) and denormalized
 * onto the row so the scheduler Durable Object can find the workspace's next
 * firing with one indexed query.
 */

/** Written to `messages.origin` for every message a routine posts. */
export const ROUTINE_ORIGIN = "routine";

/**
 * `pending` is written before the post and replaced by the outcome: it is what
 * makes "it never ran" distinguishable from "it ran and the post failed".
 */
export const ROUTINE_RUN_STATUSES = ["pending", "posted", "error"] as const;

export const routines = sqliteTable(
  "routines",
  {
    /** The agent the instruction message mentions. */
    agentId: text("agent_id").notNull(),
    /** Where the run happens - the agent answers in a thread under the post. */
    channelId: text("channel_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    id: text("id").primaryKey(),
    instructions: text("instructions").notNull(),
    /** A catalog model id; null means whatever the agent itself runs on. */
    model: text("model"),
    name: text("name").notNull(),
    /** Null whenever the routine is disabled or has no future run left. */
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    /** JSON, the `Schedule` union from `schedule.ts`. */
    schedule: text("schedule").notNull(),
    /** IANA zone the schedule's wall-clock times are read in. */
    timezone: text("timezone").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    index("routines_workspace_idx").on(table.workspaceId),
    // The scheduler's min-scan: the workspace's earliest pending firing.
    index("routines_workspace_next_run_idx").on(
      table.workspaceId,
      table.nextRunAt
    ),
  ]
);

/** One row per firing, written before the post and finalized after it. */
export const routineRuns = sqliteTable(
  "routine_runs",
  {
    error: text("error"),
    firedAt: integer("fired_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    /** The instruction message, once it exists. */
    messageId: text("message_id"),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** The slot this run answers to; equal to `firedAt` for a manual run. */
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
    status: text("status", { enum: ROUTINE_RUN_STATUSES })
      .notNull()
      .default("pending"),
  },
  (table) => [
    index("routine_runs_routine_fired_idx").on(table.routineId, table.firedAt),
  ]
);

export type Routine = typeof routines.$inferSelect;
export type RoutineRun = typeof routineRuns.$inferSelect;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];
