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
    status: text("status").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("agents_slug_unique").on(t.workspaceId, t.slug)]
);
