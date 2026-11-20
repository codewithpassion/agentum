import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, workspaceId } from "../columns.ts";
import { DEFAULT_DREAM_COUNTS_JSON, DREAM_RUN_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * One row per dream of one agent: the scheduled pass that reads what happened
 * since the last dream and rewrites the agent's memory (`docs/v4/build-plan.md`,
 * milestone DR). The note changes it made are the `memory_changes` rows that
 * name it in `dream_run_id`. A row stays after an undo, with status `undone`.
 */
export const dreamRuns = sqliteTable(
  "dream_runs",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // JSON array of library version ids: the latest version of each memory file before the dream wrote. Undo restores them.
    baseVersion: text("base_version").notNull().default("[]"),
    // JSON `DreamCounts`: added, merged, dropped, questions.
    counts: text("counts").notNull().default(DEFAULT_DREAM_COUNTS_JSON),
    // The plain-words entry the owner reads. Empty until the run ends.
    diary: text("diary").notNull().default(""),
    error: text("error"),
    // ISO 8601 UTC. Null while running.
    finishedAt: text("finished_at"),
    id: id(),
    // The library version id the dream wrote last. Null when it wrote nothing.
    resultVersion: text("result_version"),
    // ISO 8601 UTC. Start of the window the dream read: the start of the agent's previous dream, or null for its first.
    since: text("since"),
    startedAt: text("started_at").notNull(),
    status: text("status", { enum: DREAM_RUN_STATUSES }).notNull(),
    // JSON `DreamUsage`. Null until a model call has been made.
    usage: text("usage"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("dream_runs_agent_idx").on(t.workspaceId, t.agentId, t.startedAt),
  ]
);
