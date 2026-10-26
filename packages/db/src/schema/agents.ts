import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { AGENT_RUNTIMES } from "../shared.ts";
import { machines } from "./machines.ts";
import { workspaces } from "./workspaces.ts";

export const agents = sqliteTable(
  "agents",
  {
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
  ]
);
