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
import { agents } from "./agents.ts";
import { machines } from "./machines.ts";
import { workspaces } from "./workspaces.ts";

export const sessions = sqliteTable(
  "sessions",
  {
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    externalKey: text("external_key"),
    id: id(),
    lastRunAt: text("last_run_at"),
    origin: text("origin").notNull(),
    // The session this one was started from, by a hand-off or a subagent run.
    parentSessionId: text("parent_session_id").references(
      (): AnySQLiteColumn => sessions.id
    ),
    pinnedAt: text("pinned_at"),
    // Visible only to the actor, like a `ui` session. Set for a Slack DM.
    private: integer("private", { mode: "boolean" }).notNull().default(false),
    runtimeMachineId: text("runtime_machine_id").references(() => machines.id),
    // The Claude Code session id, valid only on runtime_machine_id.
    runtimeRef: text("runtime_ref"),
    // A name a person gave the thread. Null: the title comes from the origin or first message.
    title: text("title"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("sessions_last_run_idx").on(t.workspaceId, t.lastRunAt),
    uniqueIndex("sessions_artifact_unique")
      .on(t.workspaceId, t.externalKey)
      .where(sql`${t.origin} = 'artifact'`),
    uniqueIndex("sessions_key_unique").on(
      t.workspaceId,
      t.agentId,
      t.origin,
      t.externalKey
    ),
  ]
);
