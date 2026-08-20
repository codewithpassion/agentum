import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isUniqueConstraintError } from "#/db/errors";
import { syncAgentSkillsWithAnthropic } from "#/modules/anthropic/service";
import { createSkills } from "#/modules/anthropic/skills-gateway";
import {
  TOOL_OUTPUT_MAX_BYTES,
  truncateText,
  withTruncationNote,
} from "#/modules/computer/output";
import {
  publishNewSkill,
  publishSkillVersion,
  type SkillPublishContext,
} from "#/modules/skills/publish";
import {
  assignSkill,
  getAgentSkill,
  getSkillBySlug,
  listAgentIdsForSkill,
  listSkillFiles,
  listSkills,
  listSkillsForAgent,
  listSkillVersions,
  readSkillFile,
  SkillCapError,
} from "#/modules/skills/service";
import { MAX_AGENT_SKILLS, SKILL_MD_PATH } from "#/modules/skills/validate";
import { fail, json } from "./format";
import type { McpToolContext } from "./tools";

/**
 * The skills half of the agent-facing workspace. Agents read skills, write new
 * ones and - the point of the whole phase - repair a broken one by publishing a
 * fixed version with a changelog that says what failed.
 *
 * Every version an agent publishes is attributed to it, and creating a skill
 * assigns it to the author alone: handing a skill to *another* agent stays a
 * human action in the UI.
 */

const SKILL_FILE_CONTENT_MAX_LENGTH = 500_000;
const MAX_REQUESTED_FILES = 20;

/** How a version this agent authored is recorded. */
const authorOf = (ctx: McpToolContext): string => `agent:${ctx.agent.id}`;

const publishContextFor = (ctx: McpToolContext): SkillPublishContext => ({
  bucket: ctx.env.ATTACHMENTS,
  db: ctx.db,
  gateway: createSkills(ctx.env),
});

/** The slug is the only unique column on `skills`. */
const isDuplicateSlug = isUniqueConstraintError;

export interface SkillFileArgument {
  content: string;
  path: string;
}

// --- skill_list --------------------------------------------------------------

export const skillList = async (
  ctx: McpToolContext
): Promise<CallToolResult> => {
  const all = await listSkills(ctx.db);
  const mine = new Map(
    (await listSkillsForAgent(ctx.db, ctx.agent.id)).map((row) => [
      row.skill.id,
      row.pinnedVersion,
    ])
  );

  return json({
    skills: all.map((skill) => ({
      assignedToYou: mine.has(skill.id),
      description: skill.description,
      latestVersion: skill.latestVersion,
      name: skill.name,
      // A skill you are pinned to does not move when a new version lands.
      pinnedVersion: mine.get(skill.id) ?? null,
      slug: skill.slug,
      synced: skill.syncStatus === "synced",
    })),
  });
};

// --- skill_read --------------------------------------------------------------

export interface SkillReadArgs {
  /** Extra files to return the contents of, alongside SKILL.md. */
  paths?: string[];
  slug: string;
  version?: number;
}

export const skillRead = async (
  ctx: McpToolContext,
  args: SkillReadArgs
): Promise<CallToolResult> => {
  const skill = await getSkillBySlug(ctx.db, args.slug);
  if (!skill) {
    return fail(`No skill with slug ${args.slug}. Use skill_list to see them.`);
  }

  const versions = await listSkillVersions(ctx.db, skill.id);
  const wanted = args.version ?? skill.latestVersion;
  const version = versions.find((row) => row.version === wanted);
  if (!version) {
    return fail(
      `Skill ${skill.slug} has no version ${wanted}. It has ${versions.map((row) => row.version).join(", ")}.`
    );
  }

  const files = await listSkillFiles(ctx.db, version.id);
  const requested = new Set([
    SKILL_MD_PATH,
    ...(args.paths ?? []).slice(0, MAX_REQUESTED_FILES),
  ]);
  const contents: Record<string, string> = {};
  for (const file of files) {
    if (!requested.has(file.path)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small objects
    const content = await readSkillFile(ctx.env.ATTACHMENTS, file);
    contents[file.path] = withTruncationNote(
      truncateText(content ?? "", TOOL_OUTPUT_MAX_BYTES)
    );
  }

  return json({
    changelog: version.changelog,
    contents,
    createdBy: version.createdBy,
    description: skill.description,
    files: files.map((file) => ({ path: file.path, size: file.size })),
    slug: skill.slug,
    version: version.version,
    versions: versions.map((row) => ({
      changelog: row.changelog,
      createdBy: row.createdBy,
      version: row.version,
    })),
  });
};

// --- skill_create ------------------------------------------------------------

export interface SkillWriteArgs {
  changelog?: string;
  files: SkillFileArgument[];
  slug: string;
}

/**
 * Assigning the author to its own new skill, tracking latest. The cap is not
 * fatal: the skill is worth having in the workspace either way, so it is
 * created and the refusal is reported instead of losing the work.
 */
const assignAuthor = async (
  ctx: McpToolContext,
  skillId: string
): Promise<{ assigned: boolean; reason?: string }> => {
  try {
    await assignSkill(ctx.db, {
      agentId: ctx.agent.id,
      pinnedVersion: null,
      skillId,
    });
    await syncAgentSkillsWithAnthropic(ctx.db, ctx.env, [ctx.agent.id]);
    return { assigned: true };
  } catch (error) {
    if (error instanceof SkillCapError) {
      return {
        assigned: false,
        reason: `The skill was created, but you already have ${MAX_AGENT_SKILLS} skills, so it was not assigned to you. Ask the human to free a slot.`,
      };
    }
    throw error;
  }
};

export const skillCreate = async (
  ctx: McpToolContext,
  args: SkillWriteArgs
): Promise<CallToolResult> => {
  let result: Awaited<ReturnType<typeof publishNewSkill>>;
  try {
    result = await publishNewSkill(publishContextFor(ctx), {
      changelog: args.changelog ?? "Created.",
      createdBy: authorOf(ctx),
      files: args.files,
      slug: args.slug,
    });
  } catch (error) {
    if (isDuplicateSlug(error)) {
      return fail(
        `A skill called "${args.slug}" already exists. Use skill_update to publish a new version of it.`
      );
    }
    throw error;
  }
  if (!result.ok) {
    return fail(result.reason);
  }

  const assignment = await assignAuthor(ctx, result.skill.id);
  return json({
    assignedToYou: assignment.assigned,
    note: assignment.reason,
    slug: result.skill.slug,
    syncError: result.skill.syncError,
    // Unsynced is not a failure: the skill is stored and readable, and reaches
    // your sessions once the mirror retry succeeds.
    synced: result.skill.syncStatus === "synced",
    version: result.version.version,
  });
};

// --- skill_update ------------------------------------------------------------

export const skillUpdate = async (
  ctx: McpToolContext,
  args: SkillWriteArgs & { changelog: string }
): Promise<CallToolResult> => {
  const skill = await getSkillBySlug(ctx.db, args.slug);
  if (!skill) {
    return fail(
      `No skill with slug ${args.slug}. Use skill_create to make a new one.`
    );
  }

  const result = await publishSkillVersion(publishContextFor(ctx), skill, {
    changelog: args.changelog,
    createdBy: authorOf(ctx),
    files: args.files,
  });
  if (!result.ok) {
    return fail(result.reason);
  }

  // Every agent tracking latest picks this up on its next session with no
  // resync at all. The push is for the other case: an agent that was assigned
  // the skill while it had no mirror at all, which this version may have made.
  await syncAgentSkillsWithAnthropic(
    ctx.db,
    ctx.env,
    await listAgentIdsForSkill(ctx.db, skill.id)
  );
  const pin = await getAgentSkill(ctx.db, skill.id, ctx.agent.id);

  return json({
    pinnedVersion: pin?.pinnedVersion ?? null,
    slug: result.skill.slug,
    syncError: result.skill.syncError,
    synced: result.skill.syncStatus === "synced",
    version: result.version.version,
  });
};

// --- registration ------------------------------------------------------------

const SKILLS_INTRO =
  "Skills are reusable instructions plus files (SKILL.md and any scripts it needs) that a session loads when it needs them.";

const fileSchema = z.object({
  content: z.string().max(SKILL_FILE_CONTENT_MAX_LENGTH),
  path: z
    .string()
    .describe(
      'Relative to the skill root, e.g. "SKILL.md" or "scripts/run.ts".'
    ),
});

export const registerSkillTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "skill_list",
    {
      description: `${SKILLS_INTRO} List every skill in the workspace, and which ones are assigned to you.`,
      inputSchema: {},
      title: "List skills",
    },
    () => skillList(ctx)
  );

  server.registerTool(
    "skill_read",
    {
      description: `${SKILLS_INTRO} Read one version of a skill (the latest by default): its SKILL.md, its file list, and its version history. Pass paths to also get the contents of specific files - read a script before you change it.`,
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe("Extra files whose contents you want, besides SKILL.md."),
        slug: z.string(),
        version: z
          .number()
          .int()
          .optional()
          .describe("A version number; defaults to the latest."),
      },
      title: "Read a skill",
    },
    (args) => skillRead(ctx, args)
  );

  server.registerTool(
    "skill_create",
    {
      description: `${SKILLS_INTRO} Create a new skill from a complete file set and assign it to yourself. SKILL.md is required at the root, must start with YAML frontmatter, and its "name" must equal the slug. Draft and test the scripts on your own computer first, then publish the proven files here.`,
      inputSchema: {
        changelog: z
          .string()
          .optional()
          .describe("Why this skill exists, in a sentence."),
        files: z.array(fileSchema),
        slug: z
          .string()
          .describe('Lowercase kebab-case, e.g. "weekly-report".'),
      },
      title: "Create a skill",
    },
    (args) => skillCreate(ctx, args)
  );

  server.registerTool(
    "skill_update",
    {
      description: `${SKILLS_INTRO} Publish a new version of an existing skill. Send the complete file set - it replaces the version wholesale, so skill_read first - plus a changelog. When a skill fails while you are using it, this is how you fix it: diagnose the failure, correct the files, and say in the changelog what broke and what you changed. Earlier versions are never modified.`,
      inputSchema: {
        changelog: z
          .string()
          .describe('What changed and why, e.g. "fixed: script assumed bash".'),
        files: z.array(fileSchema),
        slug: z.string(),
      },
      title: "Publish a new version of a skill",
    },
    (args) => skillUpdate(ctx, args)
  );
};
