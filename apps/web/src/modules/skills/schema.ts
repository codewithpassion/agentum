import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * A skill: a SKILL.md plus whatever files it needs, versioned immutably and
 * mirrored to Anthropic (see docs/plan-connectors-skills.md, 5a).
 *
 * Local is the source of truth and the mirror is one-directional. A skill whose
 * push failed is still a usable local skill - it simply reaches no agent until
 * the retry succeeds, because `anthropicSkillId` is what an assignment needs.
 *
 * `skills.workspace_id` is the tenant boundary, and carries no foreign key to
 * `workspaces` - this module must not depend on another module's tables. It is
 * the only workspace column here: `skill_versions` and `skill_files` inherit
 * tenancy through their skill, and `agent_skills` joins two rows that already
 * carry it.
 */

/** Where a skill or a version came from: the human, or `agent:<id>`. */
export const SKILL_AUTHOR_USER = "user";

/** How the local skill stands against its Anthropic mirror. */
export const SKILL_SYNC_STATUSES = ["unsynced", "synced", "error"] as const;

export const skills = sqliteTable(
  "skills",
  {
    /**
     * Null until the first successful push. Anthropic keeps no name or
     * description at the skill level - both live on the version - so everything
     * the UI reads is mirrored here from the latest SKILL.md frontmatter.
     */
    anthropicSkillId: text("anthropic_skill_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdBy: text("created_by").notNull().default(SKILL_AUTHOR_USER),
    description: text("description").notNull(),
    id: text("id").primaryKey(),
    /** The highest `skill_versions.version`, denormalized for listing. */
    latestVersion: integer("latest_version").notNull().default(1),
    name: text("name").notNull(),
    /**
     * The one identity a skill has: the URL address, the R2 prefix, the top-level
     * directory Anthropic requires, and the SKILL.md frontmatter `name` are all
     * this string - the API rejects an upload where the last two disagree.
     * Unique within the workspace, which is as far as those addresses reach.
     */
    slug: text("slug").notNull(),
    syncError: text("sync_error"),
    syncStatus: text("sync_status", { enum: SKILL_SYNC_STATUSES })
      .notNull()
      .default("unsynced"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    unique("skills_workspace_slug_idx").on(table.workspaceId, table.slug),
  ]
);

/**
 * Immutable once written. A new version is a full copy-on-write of the file
 * set, so an agent pinned to v1 reads exactly what v1 was published with.
 */
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    /**
     * Anthropic's version identifier (a string of epoch microseconds), or null
     * when this version has not been mirrored yet.
     */
    anthropicVersion: text("anthropic_version"),
    /** Why this version exists - the audit trail an auto-heal leaves behind. */
    changelog: text("changelog").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdBy: text("created_by").notNull().default(SKILL_AUTHOR_USER),
    id: text("id").primaryKey(),
    skillId: text("skill_id").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    unique("skill_versions_number_idx").on(table.skillId, table.version),
  ]
);

/** File bodies live in R2; only the addressing lives here. */
export const skillFiles = sqliteTable("skill_files", {
  contentType: text("content_type").notNull(),
  id: text("id").primaryKey(),
  /** Relative to the skill root: `SKILL.md`, `scripts/run.ts`. */
  path: text("path").notNull(),
  r2Key: text("r2_key").notNull(),
  size: integer("size").notNull(),
  skillVersionId: text("skill_version_id").notNull(),
});

/**
 * Which agents may use which skill. `pinnedVersion` null means track latest,
 * which is what makes a published fix reach every assigned agent (5d).
 */
export const agentSkills = sqliteTable(
  "agent_skills",
  {
    agentId: text("agent_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    id: text("id").primaryKey(),
    pinnedVersion: integer("pinned_version"),
    skillId: text("skill_id").notNull(),
  },
  (table) => [unique("agent_skills_pair_idx").on(table.agentId, table.skillId)]
);

export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type SkillFile = typeof skillFiles.$inferSelect;
export type AgentSkill = typeof agentSkills.$inferSelect;
export type SkillSyncStatus = (typeof SKILL_SYNC_STATUSES)[number];
