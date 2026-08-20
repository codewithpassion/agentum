import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * The tenant boundary. A workspace owns its channels, agents, categories,
 * skills, connectors, bridges and wiki; every root table in every module
 * carries its `workspace_id` (see docs/plan-multi-tenancy.md).
 *
 * Those columns are plain text with no foreign key, the same rule the rest of
 * the codebase follows: a module must not depend on another module's tables.
 * This module owns the workspace row, and the middleware that resolves it.
 */

/** Owners manage the workspace and its members; members do everything else. */
export const WORKSPACE_ROLES = ["owner", "member"] as const;

export const workspaces = sqliteTable("workspaces", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The public identifier: url-safe, globally unique, immutable for now. */
  slug: text("slug").notNull().unique(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Who belongs to a workspace. `id` is what leaves the server - in member
 * lists, message authors, wiki authorship.
 *
 * `clerkUserId` must **never** be serialized to the client. It exists only to
 * join a Clerk session against a membership; the API answers with `id` and the
 * email/name/avatar snapshots below, which is also what makes a member list
 * render without a Clerk round-trip.
 */
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    /** Never serialized: an internal storage detail of the Clerk session. */
    clerkUserId: text("clerk_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Snapshot from Clerk, taken at add time - members are added by email. */
    email: text("email").notNull(),
    id: text("id").primaryKey(),
    imageUrl: text("image_url"),
    name: text("name"),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("workspace_members_user_idx").on(
      table.workspaceId,
      table.clerkUserId
    ),
    // "My workspaces" - the lookup every authenticated request begins with.
    index("workspace_members_clerk_idx").on(table.clerkUserId),
  ]
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
