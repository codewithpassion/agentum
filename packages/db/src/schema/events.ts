import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Append-only. The migration that creates this table also adds BEFORE UPDATE
 * and BEFORE DELETE triggers that RAISE(ABORT). drizzle-kit does not emit
 * triggers, so they are hand-written at the end of that migration.
 */
export const events = sqliteTable(
  "events",
  {
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    agentId: text("agent_id").references(() => agents.id),
    createdAt: createdAt(),
    // ULID.
    id: id(),
    // JSON, capped at 64 KB. Larger bodies go to R2 and set payload_ref.
    payload: text("payload"),
    payloadRef: text("payload_ref"),
    runId: text("run_id").references(() => runs.id),
    seq: integer("seq"),
    sessionId: text("session_id").references(() => sessions.id),
    type: text("type").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("events_session_idx").on(t.sessionId, t.id),
    index("events_run_idx").on(t.runId, t.seq),
    index("events_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("events_workspace_type_created_idx").on(
      t.workspaceId,
      t.type,
      t.createdAt
    ),
  ]
);
