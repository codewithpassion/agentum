import { sql } from "drizzle-orm";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { AGENT_RUNTIMES } from "../shared.ts";
import { machines } from "./machines.ts";
import { workspaces } from "./workspaces.ts";

export const agents = sqliteTable(
  "agents",
  {
    // The computer this agent drives. A computer serves one agent at a time
    // (`agents_computer_machine_unique`).
    // Clerk user id of the backup who is asked too once a request waits long.
    // NULL means no backup.
    backupUserId: text("backup_user_id"),
    computerMachineId: text("computer_machine_id").references(
      () => machines.id
    ),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    // The reserved mail local part. One mail domain serves every workspace, so
    // it is unique across the table. NULL for an agent without an address.
    emailLocal: text("email_local"),
    // JSON array of agent ids this agent hands work to.
    handsTo: text("hands_to").notNull().default("[]"),
    id: id(),
    instructions: text("instructions").notNull(),
    // Set when runtime is 'machine'.
    machineId: text("machine_id").references(() => machines.id),
    model: text("model").notNull(),
    name: text("name").notNull(),
    // Clerk user id of the person who answers this agent's requests. NULL
    // means `created_by`.
    ownerUserId: text("owner_user_id"),
    runtime: text("runtime", { enum: AGENT_RUNTIMES }).notNull(),
    // JSON, validated by a zod schema in the owning module.
    runtimeConfig: text("runtime_config").notNull(),
    slug: text("slug").notNull(),
    // How the agent speaks and what it is for, in the builder's words.
    soul: text("soul").notNull().default(""),
    status: text("status").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("agents_slug_unique").on(t.workspaceId, t.slug),
    uniqueIndex("agents_email_local_unique").on(t.emailLocal),
    uniqueIndex("agents_computer_machine_unique")
      .on(t.computerMachineId)
      .where(sql`${t.computerMachineId} is not null`),
  ]
);

/**
 * The one Browser Run session an agent has open, if any. A stale row is normal:
 * Browser Run closes an idle session and the next call launches a new one.
 */
export const browserSessions = sqliteTable("browser_sessions", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  // Where the session was last left, for the status line.
  currentUrl: text("current_url"),
  sessionId: text("session_id").notNull(),
  updatedAt: text("updated_at").notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});
