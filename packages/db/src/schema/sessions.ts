import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    createdAt: createdAt(),
    externalKey: text("external_key"),
    id: id(),
    lastRunAt: text("last_run_at"),
    origin: text("origin").notNull(),
    runtimeMachineId: text("runtime_machine_id").references(() => machines.id),
    // The Claude Code session id, valid only on runtime_machine_id.
    runtimeRef: text("runtime_ref"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("sessions_key_unique").on(
      t.workspaceId,
      t.agentId,
      t.origin,
      t.externalKey
    ),
  ]
);
