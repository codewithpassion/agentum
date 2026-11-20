import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, ownerCheck, workspaceId } from "../columns.ts";
import {
  MEMORY_CHANGE_ACTIONS,
  MEMORY_CHANGE_STATUSES,
  MEMORY_NOTE_KINDS,
  MEMORY_SOURCE_KINDS,
  MEMORY_WRITERS,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { libraryVersions } from "./library.ts";
import { teams } from "./teams.ts";
import { workspaces } from "./workspaces.ts";

/**
 * One row per change to an agent's memory files, kept for the Learned this
 * week list, held notes and undo. The notes themselves are files in
 * `agents/<slug>/memory/` (`docs/v4/memory-format.md`); only the memory service
 * writes them.
 */
export const memoryChanges = sqliteTable(
  "memory_changes",
  {
    action: text("action", { enum: MEMORY_CHANGE_ACTIONS }).notNull(),
    // The agent whose memory changed. Null on a team memory change (`team_id`). A row has an agent or a team.
    agentId: text("agent_id").references(() => agents.id),
    createdAt: createdAt(),
    // ISO 8601 UTC. Set when a person decides a held change or undoes an applied one.
    decidedAt: text("decided_at"),
    // Clerk user id.
    decidedBy: text("decided_by"),
    // The `dream_runs` row that made the change. Left without a foreign key, because adding one would rebuild this table.
    dreamRunId: text("dream_run_id"),
    // The id of the `merge` row when this row belongs to a merge: set on that row itself and on the `forget` row of each note it absorbed. Null for every other change.
    groupId: text("group_id"),
    id: id(),
    kind: text("kind", { enum: MEMORY_NOTE_KINDS }).notNull(),
    // The library version this change wrote. Null while held and when rejected.
    libraryVersionId: text("library_version_id").references(
      () => libraryVersions.id
    ),
    noteId: text("note_id").notNull(),
    // The id of the session, run or request the note came from. Both source columns are null for a note a person typed.
    sourceId: text("source_id"),
    sourceKind: text("source_kind", { enum: MEMORY_SOURCE_KINDS }),
    status: text("status", { enum: MEMORY_CHANGE_STATUSES }).notNull(),
    // The team whose memory changed. Null on an agent's memory change.
    teamId: text("team_id").references(() => teams.id),
    // The note's text after the change; for a forget, the text that was forgotten.
    text: text("text").notNull(),
    // Clerk user id of the person a private note belongs to. Null for a shared note.
    userScope: text("user_scope"),
    workspaceId: workspaceId().references(() => workspaces.id),
    writtenBy: text("written_by", { enum: MEMORY_WRITERS }).notNull(),
  },
  (t) => [
    index("memory_changes_agent_idx").on(t.workspaceId, t.agentId, t.createdAt),
    index("memory_changes_status_idx").on(t.workspaceId, t.status),
    index("memory_changes_note_idx").on(t.workspaceId, t.noteId),
    index("memory_changes_team_idx").on(t.workspaceId, t.teamId, t.createdAt),
    check("memory_changes_owner", ownerCheck(t.agentId, t.teamId)),
  ]
);
