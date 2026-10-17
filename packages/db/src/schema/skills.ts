import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { SKILL_AUTHOR_KINDS, SKILL_VERSION_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A skill in the central store (SK.1). The files live in `skill_versions`, each
 * version holding a full tree. A name is unique within its owner: one agent's
 * skills, or the people-owned skills (`owner_agent_id` null). Two agents may
 * each own a skill of the same name, and a shared one may share it too, as the
 * library allowed.
 */
export const skills = sqliteTable(
  "skills",
  {
    createdAt: createdAt(),
    // Clerk user id or agent id, see `created_by_kind`. "migration" for a skill moved from the library.
    createdBy: text("created_by").notNull(),
    createdByKind: text("created_by_kind", {
      enum: SKILL_AUTHOR_KINDS,
    }).notNull(),
    // 1 once removed. Nothing lists a removed skill.
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    id: id(),
    name: text("name").notNull(),
    // Null: owned by people.
    ownerAgentId: text("owner_agent_id").references(() => agents.id),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("skills_agent_name_unique")
      .on(t.workspaceId, t.ownerAgentId, t.name)
      .where(sql`${t.ownerAgentId} IS NOT NULL`),
    uniqueIndex("skills_people_name_unique")
      .on(t.workspaceId, t.name)
      .where(sql`${t.ownerAgentId} IS NULL`),
  ]
);

/**
 * One commit: a full file tree, not a delta (the tree is `skill_version_files`).
 * `number` counts 1, 2, ... per skill, and the unique index on it is what
 * refuses two commits that raced on the same base. `parent_number` is the
 * version the commit was made on, null for version 1.
 */
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    approvedAt: text("approved_at"),
    // Clerk user id, or "migration" for the library migration.
    approvedBy: text("approved_by"),
    // Agent id or Clerk user id, see `author_kind`. "migration" for the library migration.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", { enum: SKILL_AUTHOR_KINDS }).notNull(),
    // Set when an agent's run wrote the version.
    authorRunId: text("author_run_id"),
    createdAt: createdAt(),
    id: id(),
    message: text("message").notNull(),
    number: integer("number").notNull(),
    // The number of the version this one was made on, null for version 1.
    parentNumber: integer("parent_number"),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    status: text("status", { enum: SKILL_VERSION_STATUSES }).notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("skill_versions_number_unique").on(t.skillId, t.number)]
);

/**
 * A file of a version. Bytes live in R2 under `skill-blobs/<hash>`, written
 * once and shared by every version and skill that holds the same bytes.
 */
export const skillVersionFiles = sqliteTable(
  "skill_version_files",
  {
    executable: integer("executable", { mode: "boolean" })
      .notNull()
      .default(false),
    // SHA-256, lower-case hex.
    hash: text("hash").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => skillVersions.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.path] })]
);

/**
 * A skill an agent carries. `pinned_version_id` null follows the latest
 * approved version. A skill appears at most once per agent.
 */
export const skillAssignments = sqliteTable(
  "skill_assignments",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    createdAt: createdAt(),
    pinnedVersionId: text("pinned_version_id").references(
      () => skillVersions.id
    ),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.skillId] }),
    index("skill_assignments_skill_idx").on(t.skillId),
  ]
);

/** One row per workspace whose library skills were moved into the store. */
export const skillLibraryMigrations = sqliteTable("skill_library_migrations", {
  migratedAt: text("migrated_at").notNull(),
  workspaceId: workspaceId()
    .primaryKey()
    .references(() => workspaces.id),
});
