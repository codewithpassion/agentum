import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import type {
  SkillsGateway,
  SkillUpload,
} from "#/modules/anthropic/skills-gateway";
import { agentSkills, type Skill, type SkillVersion } from "./schema";
import {
  addSkillVersion,
  createSkill,
  listAgentIdsForSkill,
  listSkillFiles,
  listSkillVersions,
  readSkillFile,
  setSkillSyncState,
  setVersionAnthropicVersion,
} from "./service";
import { type SkillFileInput, validateSkill } from "./validate";

/**
 * The publish pipeline: validate, write locally, then mirror to Anthropic.
 *
 * The order is the contract. Local is the source of truth, so a version exists
 * and is readable the moment D1 and R2 have it; the mirror is a second step
 * whose failure is recorded on the skill (`syncStatus: error`) and retried,
 * never one that loses a version the author just wrote.
 */

export interface SkillPublishContext {
  bucket: R2Bucket;
  db: Db;
  /** Null when the Anthropic integration is off - see `createSkills`. */
  gateway: SkillsGateway | null;
}

export interface PublishInput {
  changelog: string;
  createdBy: string;
  files: readonly SkillFileInput[];
  slug: string;
}

export type PublishResult =
  | { ok: true; skill: Skill; version: SkillVersion }
  | { ok: false; reason: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const uploadFrom = (
  slug: string,
  displayTitle: string,
  files: readonly { content: string; contentType: string; path: string }[]
): SkillUpload => ({
  displayTitle,
  files: files.map((file) => ({
    content: file.content,
    contentType: file.contentType,
    path: file.path,
  })),
  slug,
});

/** Rebuilds a stored version's upload from R2, which is where its bytes live. */
const uploadForVersion = async (
  ctx: SkillPublishContext,
  skill: Skill,
  version: SkillVersion
): Promise<SkillUpload | null> => {
  const rows = await listSkillFiles(ctx.db, version.id);
  const files: { content: string; contentType: string; path: string }[] = [];
  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small objects, read in path order
    const content = await readSkillFile(ctx.bucket, row);
    if (content === null) {
      return null;
    }
    files.push({ content, contentType: row.contentType, path: row.path });
  }
  return files.length > 0 ? uploadFrom(skill.slug, skill.name, files) : null;
};

/**
 * One version, pushed. Returns the skill row as it now stands - the mirror ids
 * and the sync status are the only things this can change.
 */
const pushVersion = async (
  ctx: SkillPublishContext,
  skill: Skill,
  version: SkillVersion,
  upload: SkillUpload
): Promise<Skill> => {
  if (!ctx.gateway) {
    // No key configured (or the kill switch is on): the skill is a perfectly
    // good local skill, waiting for a retry. That is not an error state.
    return skill;
  }

  try {
    if (skill.anthropicSkillId) {
      const anthropicVersion = await ctx.gateway.createVersion(
        skill.anthropicSkillId,
        upload
      );
      await setVersionAnthropicVersion(ctx.db, version.id, anthropicVersion);
      await setSkillSyncState(ctx.db, skill.id, { syncStatus: "synced" });
      return { ...skill, syncError: null, syncStatus: "synced" };
    }

    const published = await ctx.gateway.createSkill(upload);
    await setVersionAnthropicVersion(
      ctx.db,
      version.id,
      published.anthropicVersion
    );
    await setSkillSyncState(ctx.db, skill.id, {
      anthropicSkillId: published.anthropicSkillId,
      syncStatus: "synced",
    });
    return {
      ...skill,
      anthropicSkillId: published.anthropicSkillId,
      syncError: null,
      syncStatus: "synced",
    };
  } catch (error) {
    const syncError = messageOf(error);
    await setSkillSyncState(ctx.db, skill.id, {
      syncError,
      syncStatus: "error",
    });
    return { ...skill, syncError, syncStatus: "error" };
  }
};

/** A brand-new skill at version 1. The slug must be free. */
export const publishNewSkill = async (
  ctx: SkillPublishContext,
  workspaceId: string,
  input: PublishInput
): Promise<PublishResult> => {
  const validation = validateSkill({ files: input.files, slug: input.slug });
  if (!validation.ok) {
    return validation;
  }

  const written = await createSkill(ctx.db, ctx.bucket, workspaceId, {
    changelog: input.changelog,
    createdBy: input.createdBy,
    skill: validation.skill,
    slug: input.slug,
  });
  const skill = await pushVersion(
    ctx,
    written.skill,
    written.version,
    uploadFrom(input.slug, validation.skill.name, validation.skill.files)
  );
  return { ok: true, skill, version: written.version };
};

/** A new version of an existing skill. The previous version is left untouched. */
export const publishSkillVersion = async (
  ctx: SkillPublishContext,
  skill: Skill,
  input: Omit<PublishInput, "slug">
): Promise<PublishResult> => {
  const validation = validateSkill({ files: input.files, slug: skill.slug });
  if (!validation.ok) {
    return validation;
  }

  const written = await addSkillVersion(ctx.db, ctx.bucket, skill, {
    changelog: input.changelog,
    createdBy: input.createdBy,
    skill: validation.skill,
  });
  const pushed = await pushVersion(
    ctx,
    written.skill,
    written.version,
    uploadFrom(skill.slug, validation.skill.name, validation.skill.files)
  );
  return { ok: true, skill: pushed, version: written.version };
};

/**
 * Pushes every version that has no mirror yet, oldest first.
 *
 * Oldest first because the versions are an ordered history on Anthropic's side
 * too: pushing only the newest would leave an agent pinned to v1 permanently
 * unattachable, since a pin needs *that* version's mirror id.
 */
export const retrySkillSync = async (
  ctx: SkillPublishContext,
  skill: Skill
): Promise<Skill> => {
  if (!ctx.gateway) {
    return skill;
  }

  const pending = (await listSkillVersions(ctx.db, skill.id))
    .filter((version) => version.anthropicVersion === null)
    .reverse();

  let current = skill;
  for (const version of pending) {
    // biome-ignore lint/performance/noAwaitInLoops: versions must land in order
    const upload = await uploadForVersion(ctx, current, version);
    if (!upload) {
      await setSkillSyncState(ctx.db, current.id, {
        syncError: `Version ${version.version} is missing its files in storage.`,
        syncStatus: "error",
      });
      return { ...current, syncStatus: "error" };
    }
    current = await pushVersion(ctx, current, version, upload);
    if (current.syncStatus === "error") {
      return current;
    }
  }
  return current;
};

/**
 * Drops every assignment of this skill, and says whose agents changed so the
 * caller can push the skills-only update before the mirror goes away.
 */
export const unassignSkillEverywhere = async (
  db: Db,
  skillId: string
): Promise<string[]> => {
  const agentIds = await listAgentIdsForSkill(db, skillId);
  await db.delete(agentSkills).where(eq(agentSkills.skillId, skillId));
  return agentIds;
};

/**
 * Removes the Anthropic side of a skill *we* created. Versions go first - the
 * API refuses to delete a skill while any exist - and every failure is
 * tolerated and reported, because the local delete must still complete.
 */
export const deleteSkillMirror = async (
  ctx: SkillPublishContext,
  skill: Skill
): Promise<string | null> => {
  if (!(ctx.gateway && skill.anthropicSkillId)) {
    return null;
  }
  const { gateway } = ctx;
  const skillId = skill.anthropicSkillId;

  try {
    const versions = await gateway.listVersions(skillId);
    for (const version of versions) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential best-effort cleanup
      await gateway.deleteVersion(skillId, version);
    }
    await gateway.deleteSkill(skillId);
    return null;
  } catch (error) {
    return messageOf(error);
  }
};
