import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  DEFAULT_DREAM_COUNTS_JSON,
  DREAM_QUESTION_STATUSES,
  DREAM_RUN_STATUSES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { teams } from "./teams.ts";
import { workspaces } from "./workspaces.ts";

/**
 * One row per dream of one agent or one team: the scheduled pass that reads what happened
 * since the last dream and rewrites the agent's memory (`docs/v4/build-plan.md`,
 * milestone DR). The note changes it made are the `memory_changes` rows that
 * name it in `dream_run_id`. A row stays after an undo, with status `undone`.
 */
export const dreamRuns = sqliteTable(
  "dream_runs",
  {
    // The agent that dreamed. Null on a team dream (`team_id`). A row has an agent or a team.
    agentId: text("agent_id").references(() => agents.id),
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
    // The team that dreamed. Null on an agent's dream.
    teamId: text("team_id").references(() => teams.id),
    // JSON `DreamUsage`. Null until a model call has been made.
    usage: text("usage"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("dream_runs_agent_idx").on(t.workspaceId, t.agentId, t.startedAt),
    index("dream_runs_team_idx").on(t.workspaceId, t.teamId, t.startedAt),
  ]
);

/**
 * A contradiction a dream could not settle, asked of the agent's owner as a
 * `dream_question` Needs you card. The answer keeps one of the options and
 * drops the others.
 */
export const dreamQuestions = sqliteTable(
  "dream_questions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // ISO 8601 UTC. Set with `answered_by` and `answered_note_id` when a person answers.
    answeredAt: text("answered_at"),
    // Clerk user id.
    answeredBy: text("answered_by"),
    // The option the person kept.
    answeredNoteId: text("answered_note_id"),
    createdAt: createdAt(),
    dreamRunId: text("dream_run_id")
      .notNull()
      .references(() => dreamRuns.id),
    id: id(),
    // JSON `DreamQuestionOption[]`, at least two: the notes that disagree, with their text when the dream asked.
    options: text("options").notNull(),
    question: text("question").notNull(),
    status: text("status", { enum: DREAM_QUESTION_STATUSES }).notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("dream_questions_status_idx").on(t.workspaceId, t.status),
    index("dream_questions_run_idx").on(t.dreamRunId),
  ]
);
