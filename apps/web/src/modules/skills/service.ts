import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
  type AgentSkill,
  agentSkills,
  type Skill,
  type SkillFile,
  type SkillSyncStatus,
  type SkillVersion,
  skillFiles,
  skills,
  skillVersions,
} from "./schema";
import { MAX_AGENT_SKILLS, type ValidatedSkill } from "./validate";

/**
 * The skills store: D1 rows for everything addressable, R2 for the file bodies
 * (the same rule as wiki assets - never blobs in D1).
 *
 * A version is immutable. Publishing a new one writes a fresh file set under a
 * fresh key prefix and never touches the previous version's rows or objects,
 * which is what makes a pinned agent reproducible.
 */

/** R2 prefix; the bucket is shared with wiki assets and message attachments. */
const SKILL_KEY_PREFIX = "skills/";

export const skillFileKey = (
  skillId: string,
  version: number,
  path: string
): string => `${SKILL_KEY_PREFIX}${skillId}/${version}/${path}`;

// --- views ------------------------------------------------------------------

/** Timestamps cross the wire as epoch milliseconds, as everywhere else. */
export interface SkillView {
  createdAt: number;
  createdBy: string;
  description: string;
  id: string;
  latestVersion: number;
  name: string;
  slug: string;
  syncError: string | null;
  syncStatus: SkillSyncStatus;
  updatedAt: number;
}

export interface SkillVersionView {
  anthropicVersion: string | null;
  changelog: string;
  createdAt: number;
  createdBy: string;
  id: string;
  version: number;
}

export interface SkillFileView {
  contentType: string;
  path: string;
  size: number;
}

export const toSkillView = (skill: Skill): SkillView => ({
  createdAt: skill.createdAt.getTime(),
  createdBy: skill.createdBy,
  description: skill.description,
  id: skill.id,
  latestVersion: skill.latestVersion,
  name: skill.name,
  slug: skill.slug,
  syncError: skill.syncError,
  syncStatus: skill.syncStatus,
  updatedAt: skill.updatedAt.getTime(),
});

export const toSkillVersionView = (
  version: SkillVersion
): SkillVersionView => ({
  anthropicVersion: version.anthropicVersion,
  changelog: version.changelog,
  createdAt: version.createdAt.getTime(),
  createdBy: version.createdBy,
  id: version.id,
  version: version.version,
});

export const toSkillFileView = (file: SkillFile): SkillFileView => ({
  contentType: file.contentType,
  path: file.path,
  size: file.size,
});

// --- reads ------------------------------------------------------------------

export const listSkills = (db: Db): Promise<Skill[]> =>
  db.select().from(skills).orderBy(asc(skills.slug));

export const getSkillBySlug = async (
  db: Db,
  slug: string
): Promise<Skill | undefined> => {
  const [skill] = await db.select().from(skills).where(eq(skills.slug, slug));
  return skill;
};

export const getSkillById = async (
  db: Db,
  id: string
): Promise<Skill | undefined> => {
  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  return skill;
};

/** Newest first: the history list, and the retry pass reverses it. */
export const listSkillVersions = (
  db: Db,
  skillId: string
): Promise<SkillVersion[]> =>
  db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(desc(skillVersions.version));

export const getSkillVersion = async (
  db: Db,
  skillId: string,
  version: number
): Promise<SkillVersion | undefined> => {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.version, version)
      )
    );
  return row;
};

export const listSkillFiles = (
  db: Db,
  skillVersionId: string
): Promise<SkillFile[]> =>
  db
    .select()
    .from(skillFiles)
    .where(eq(skillFiles.skillVersionId, skillVersionId))
    .orderBy(asc(skillFiles.path));

export const getSkillFile = async (
  db: Db,
  skillVersionId: string,
  path: string
): Promise<SkillFile | undefined> => {
  const [file] = await db
    .select()
    .from(skillFiles)
    .where(
      and(
        eq(skillFiles.skillVersionId, skillVersionId),
        eq(skillFiles.path, path)
      )
    );
  return file;
};

/** Null when the object is gone - R2 is the source of truth for content. */
export const readSkillFile = async (
  bucket: R2Bucket,
  file: SkillFile
): Promise<string | null> => {
  const object = await bucket.get(file.r2Key);
  return object ? await object.text() : null;
};

// --- writes -----------------------------------------------------------------

export interface WriteSkillInput {
  changelog: string;
  /** `user`, or `agent:<id>` when a skill authored itself. */
  createdBy: string;
  skill: ValidatedSkill;
  slug: string;
}

export interface WrittenVersion {
  files: SkillFile[];
  skill: Skill;
  version: SkillVersion;
}

const writeFiles = async (
  db: Db,
  bucket: R2Bucket,
  target: { skillId: string; versionId: string; versionNumber: number },
  validated: ValidatedSkill
): Promise<SkillFile[]> => {
  const prepared = validated.files.map((file) => ({
    content: file.content,
    row: {
      contentType: file.contentType,
      id: crypto.randomUUID(),
      path: file.path,
      r2Key: skillFileKey(target.skillId, target.versionNumber, file.path),
      size: file.size,
      skillVersionId: target.versionId,
    },
  }));

  // R2 first: a row pointing at an object that was never written would be a
  // version that reads as empty, which is worse than a stray object.
  await Promise.all(
    prepared.map((entry) =>
      bucket.put(entry.row.r2Key, entry.content, {
        httpMetadata: { contentType: entry.row.contentType },
      })
    )
  );
  await db.insert(skillFiles).values(prepared.map((entry) => entry.row));
  return prepared.map((entry) => ({ ...entry.row }));
};

/**
 * A skill and its version 1, together: a skill with no version is not a thing
 * the rest of the module knows how to handle.
 */
export const createSkill = async (
  db: Db,
  bucket: R2Bucket,
  workspaceId: string,
  input: WriteSkillInput
): Promise<WrittenVersion> => {
  const skillId = crypto.randomUUID();
  const [skill] = await db
    .insert(skills)
    .values({
      createdBy: input.createdBy,
      description: input.skill.description,
      id: skillId,
      latestVersion: 1,
      name: input.skill.name,
      slug: input.slug,
      workspaceId,
    })
    .returning();
  if (!skill) {
    throw new Error("Failed to create the skill.");
  }

  const [version] = await db
    .insert(skillVersions)
    .values({
      changelog: input.changelog,
      createdBy: input.createdBy,
      id: crypto.randomUUID(),
      skillId,
      version: 1,
    })
    .returning();
  if (!version) {
    throw new Error("Failed to create the skill version.");
  }

  const files = await writeFiles(
    db,
    bucket,
    { skillId, versionId: version.id, versionNumber: 1 },
    input.skill
  );
  return { files, skill, version };
};

/**
 * The next version, as a full copy-on-write file set. Nothing belonging to an
 * earlier version is read, rewritten or deleted here - that is the immutability
 * guarantee, and the reason a new key prefix is used rather than a new object
 * at the same key.
 */
export const addSkillVersion = async (
  db: Db,
  bucket: R2Bucket,
  skill: Skill,
  input: Omit<WriteSkillInput, "slug">
): Promise<WrittenVersion> => {
  const versionNumber = skill.latestVersion + 1;
  const [version] = await db
    .insert(skillVersions)
    .values({
      changelog: input.changelog,
      createdBy: input.createdBy,
      id: crypto.randomUUID(),
      skillId: skill.id,
      version: versionNumber,
    })
    .returning();
  if (!version) {
    throw new Error("Failed to create the skill version.");
  }

  const files = await writeFiles(
    db,
    bucket,
    { skillId: skill.id, versionId: version.id, versionNumber },
    input.skill
  );

  // The skill row mirrors the newest SKILL.md frontmatter: that is what the
  // directory lists and what an agent reads before deciding to use the skill.
  const [updated] = await db
    .update(skills)
    .set({
      description: input.skill.description,
      latestVersion: versionNumber,
      name: input.skill.name,
      updatedAt: new Date(),
    })
    .where(eq(skills.id, skill.id))
    .returning();

  return { files, skill: updated ?? skill, version };
};

export interface SkillSyncState {
  anthropicSkillId?: string;
  syncError?: string | null;
  syncStatus: SkillSyncStatus;
}

export const setSkillSyncState = async (
  db: Db,
  skillId: string,
  state: SkillSyncState
): Promise<void> => {
  await db
    .update(skills)
    .set({
      ...(state.anthropicSkillId
        ? { anthropicSkillId: state.anthropicSkillId }
        : {}),
      syncError: state.syncError ?? null,
      syncStatus: state.syncStatus,
      updatedAt: new Date(),
    })
    .where(eq(skills.id, skillId));
};

/** The one field on a version that is written after creation: its mirror id. */
export const setVersionAnthropicVersion = async (
  db: Db,
  versionId: string,
  anthropicVersion: string
): Promise<void> => {
  await db
    .update(skillVersions)
    .set({ anthropicVersion })
    .where(eq(skillVersions.id, versionId));
};

/**
 * Local removal only. Unassigning the agents and deleting the Anthropic mirror
 * are the caller's job (see `publish.ts`), because both need more than the db.
 */
export const deleteSkillLocally = async (
  db: Db,
  bucket: R2Bucket,
  skill: Skill
): Promise<void> => {
  const versions = await listSkillVersions(db, skill.id);
  const versionIds = versions.map((version) => version.id);

  if (versionIds.length > 0) {
    const files = await db
      .select()
      .from(skillFiles)
      .where(inArray(skillFiles.skillVersionId, versionIds));
    await Promise.all(files.map((file) => bucket.delete(file.r2Key)));
    await db
      .delete(skillFiles)
      .where(inArray(skillFiles.skillVersionId, versionIds));
  }

  await db.delete(skillVersions).where(eq(skillVersions.skillId, skill.id));
  await db.delete(agentSkills).where(eq(agentSkills.skillId, skill.id));
  await db.delete(skills).where(eq(skills.id, skill.id));
};

// --- assignment -------------------------------------------------------------

/** The 20-skills-per-agent cap, refused where a human can still do something. */
export class SkillCapError extends Error {}

export const listAgentIdsForSkill = async (
  db: Db,
  skillId: string
): Promise<string[]> => {
  const rows = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .where(eq(agentSkills.skillId, skillId));
  return rows.map((row) => row.agentId);
};

export interface AssignedSkill {
  pinnedVersion: number | null;
  skill: Skill;
}

export const listSkillsForAgent = async (
  db: Db,
  agentId: string
): Promise<AssignedSkill[]> => {
  const rows = await db
    .select({ pinnedVersion: agentSkills.pinnedVersion, skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skills.slug));
  return rows.map((row) => ({
    pinnedVersion: row.pinnedVersion,
    skill: row.skill,
  }));
};

/**
 * What an `agents.update` needs: the mirror ids, plus the pinned version's own
 * mirror id when the assignment pins one. Resolved here, in one query, because
 * `modules/anthropic` composes the payload but must not know the schema.
 */
export interface AgentSkillAssignment {
  anthropicSkillId: string | null;
  /** The pinned version's Anthropic id; null when it was never mirrored. */
  pinnedAnthropicVersion: string | null;
  pinnedVersion: number | null;
  slug: string;
}

export const listAgentSkillAssignments = async (
  db: Db,
  agentId: string
): Promise<AgentSkillAssignment[]> => {
  const assigned = await listSkillsForAgent(db, agentId);
  const pinned = assigned.filter((row) => row.pinnedVersion !== null);

  const mirrors = new Map<string, string | null>();
  if (pinned.length > 0) {
    const rows = await db
      .select()
      .from(skillVersions)
      .where(
        inArray(
          skillVersions.skillId,
          pinned.map((row) => row.skill.id)
        )
      );
    for (const row of rows) {
      mirrors.set(`${row.skillId}:${row.version}`, row.anthropicVersion);
    }
  }

  return assigned.map((row) => ({
    anthropicSkillId: row.skill.anthropicSkillId,
    pinnedAnthropicVersion:
      row.pinnedVersion === null
        ? null
        : (mirrors.get(`${row.skill.id}:${row.pinnedVersion}`) ?? null),
    pinnedVersion: row.pinnedVersion,
    slug: row.skill.slug,
  }));
};

export interface AssignSkillInput {
  agentId: string;
  /** Null (or omitted) tracks latest, which is the auto-heal path. */
  pinnedVersion?: number | null;
  skillId: string;
}

export type AssignSkillOutcome = "assigned" | "repinned" | "unchanged";

/**
 * Idempotent by (agent, skill): assigning again only moves the pin. Returning
 * `unchanged` is what lets the caller skip a pointless Anthropic round trip.
 */
export const assignSkill = async (
  db: Db,
  input: AssignSkillInput
): Promise<AssignSkillOutcome> => {
  const pinnedVersion = input.pinnedVersion ?? null;
  const existing = await db
    .select()
    .from(agentSkills)
    .where(eq(agentSkills.agentId, input.agentId));

  const current = existing.find((row) => row.skillId === input.skillId);
  if (current) {
    if (current.pinnedVersion === pinnedVersion) {
      return "unchanged";
    }
    await db
      .update(agentSkills)
      .set({ pinnedVersion })
      .where(eq(agentSkills.id, current.id));
    return "repinned";
  }

  if (existing.length >= MAX_AGENT_SKILLS) {
    throw new SkillCapError(
      `An agent can use at most ${MAX_AGENT_SKILLS} skills. Remove one before adding another.`
    );
  }

  await db
    .insert(agentSkills)
    .values({
      agentId: input.agentId,
      id: crypto.randomUUID(),
      pinnedVersion,
      skillId: input.skillId,
    })
    .onConflictDoNothing();
  return "assigned";
};

export const unassignSkill = async (
  db: Db,
  skillId: string,
  agentId: string
): Promise<boolean> => {
  const removed = await db
    .delete(agentSkills)
    .where(
      and(eq(agentSkills.skillId, skillId), eq(agentSkills.agentId, agentId))
    )
    .returning({ id: agentSkills.id });
  return removed.length > 0;
};

export const getAgentSkill = async (
  db: Db,
  skillId: string,
  agentId: string
): Promise<AgentSkill | undefined> => {
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(
      and(eq(agentSkills.skillId, skillId), eq(agentSkills.agentId, agentId))
    );
  return row;
};
