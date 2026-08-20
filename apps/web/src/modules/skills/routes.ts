import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { getAgentById, getAgentsByIds } from "#/modules/agents/service";
import { syncAgentSkillsWithAnthropic } from "#/modules/anthropic/service";
import { createSkills } from "#/modules/anthropic/skills-gateway";
import {
  deleteSkillMirror,
  publishNewSkill,
  publishSkillVersion,
  retrySkillSync,
  type SkillPublishContext,
  unassignSkillEverywhere,
} from "./publish";
import type { Skill } from "./schema";
import {
  assignSkill,
  deleteSkillLocally,
  getAgentSkill,
  getSkillBySlug,
  getSkillFile,
  getSkillVersion,
  listAgentIdsForSkill,
  listSkillFiles,
  listSkills,
  listSkillsForAgent,
  listSkillVersions,
  readSkillFile,
  SkillCapError,
  toSkillFileView,
  toSkillVersionView,
  toSkillView,
  unassignSkill,
} from "./service";
import { MAX_SKILL_SLUG_LENGTH, type SkillFileInput } from "./validate";

/**
 * The Skills API. Files arrive as JSON text rather than multipart: a skill is
 * SKILL.md plus scripts, all of it text an editor (or an agent) produces in
 * one payload, and the same shape backs the `skill_*` MCP tools.
 */

const CONFLICT = 409;
const CHANGELOG_MAX_LENGTH = 1000;
const FILE_CONTENT_MAX_LENGTH = 5_000_000;

const contextFor = (c: Context<ApiEnv>): SkillPublishContext => ({
  bucket: c.env.ATTACHMENTS,
  db: createDb(c.env.DB),
  gateway: createSkills(c.env),
});

/** Slugs are unique per workspace, so the lookup names both halves. */
const requireSkill = async (
  c: Context<ApiEnv>,
  ctx: SkillPublishContext,
  slug: string
): Promise<Skill> => {
  const skill = await getSkillBySlug(ctx.db, c.get("workspace").id, slug);
  if (!skill) {
    throw notFound("Skill not found.");
  }
  return skill;
};

/** `[{ path, content }]`, checked shallowly here and fully in `validateSkill`. */
const requireFiles = (body: Record<string, unknown>): SkillFileInput[] => {
  const raw = body.files;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('"files" must be a non-empty array of { path, content }.');
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw badRequest(
        'Each file must be an object with "path" and "content".'
      );
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.trim().length === 0) {
      throw badRequest('Each file needs a non-empty "path".');
    }
    if (typeof file.content !== "string") {
      throw badRequest(`"${file.path}" needs a string "content".`);
    }
    if (file.content.length > FILE_CONTENT_MAX_LENGTH) {
      throw badRequest(`"${file.path}" is too large.`);
    }
    return { content: file.content, path: file.path.trim() };
  });
};

/**
 * A skills change reaches an agent as a partial `agents.update` carrying only
 * `skills` - no token rotation, nothing to wait for - so it runs behind the
 * response rather than being deferred to session-idle the way connectors are.
 */
const syncAgents = (
  c: Context<ApiEnv>,
  db: ReturnType<typeof createDb>,
  agentIds: readonly string[]
): void => {
  if (agentIds.length === 0) {
    return;
  }
  const work = syncAgentSkillsWithAnthropic(db, c.env, agentIds).catch(() => {
    // Every failure path records itself on the agent row.
  });
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a direct fetch in a test): let it run detached.
  }
};

export const skillsRoutes = new Hono<ApiEnv>();

skillsRoutes.use("*", requireAuth);

skillsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const agentId = c.req.query("agentId");
  if (agentId) {
    // An agent's skills are its own workspace's; resolving the agent scoped is
    // what stops another tenant's id being asked about.
    if (!(await getAgentById(db, workspaceId, agentId))) {
      throw notFound("Agent not found.");
    }
    const assigned = await listSkillsForAgent(db, agentId);
    return c.json({
      skills: assigned.map((row) => ({
        ...toSkillView(row.skill),
        pinnedVersion: row.pinnedVersion,
      })),
    });
  }
  return c.json({
    skills: (await listSkills(db, workspaceId)).map(toSkillView),
  });
});

skillsRoutes.post("/", async (c) => {
  const ctx = contextFor(c);
  const body = await readJsonObject(c.req.raw);
  const slug = requireString(body, "slug", {
    maxLength: MAX_SKILL_SLUG_LENGTH,
  });

  let result: Awaited<ReturnType<typeof publishNewSkill>>;
  try {
    result = await publishNewSkill(ctx, c.get("workspace").id, {
      changelog:
        optionalString(body, "changelog", {
          maxLength: CHANGELOG_MAX_LENGTH,
        }) ?? "Created.",
      createdBy: "user",
      files: requireFiles(body),
      slug,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json(
        { error: `A skill called "${slug}" already exists.` },
        CONFLICT
      );
    }
    throw error;
  }

  if (!result.ok) {
    return c.json({ error: result.reason }, 400);
  }
  return c.json(
    {
      skill: toSkillView(result.skill),
      version: toSkillVersionView(result.version),
    },
    201
  );
});

skillsRoutes.get("/:slug", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const requested = c.req.query("version");
  const versions = await listSkillVersions(ctx.db, skill.id);
  const version = requested
    ? versions.find((row) => String(row.version) === requested)
    : versions.find((row) => row.version === skill.latestVersion);
  if (!version) {
    throw notFound("Skill version not found.");
  }

  return c.json({
    files: (await listSkillFiles(ctx.db, version.id)).map(toSkillFileView),
    skill: toSkillView(skill),
    version: toSkillVersionView(version),
    versions: versions.map(toSkillVersionView),
  });
});

/** One file's bytes, addressed by path within a version. */
skillsRoutes.get("/:slug/versions/:version/file", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const version = await getSkillVersion(
    ctx.db,
    skill.id,
    Number(c.req.param("version"))
  );
  if (!version) {
    throw notFound("Skill version not found.");
  }

  const path = c.req.query("path");
  if (!path) {
    throw badRequest('A "path" query parameter is required.');
  }
  const file = await getSkillFile(ctx.db, version.id, path);
  if (!file) {
    throw notFound("File not found in this version.");
  }
  const content = await readSkillFile(ctx.bucket, file);
  if (content === null) {
    throw notFound("File content is missing.");
  }

  return new Response(content, {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Type": `${file.contentType}; charset=utf-8`,
    },
  });
});

skillsRoutes.post("/:slug/versions", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const body = await readJsonObject(c.req.raw);

  const result = await publishSkillVersion(ctx, skill, {
    changelog: requireString(body, "changelog", {
      maxLength: CHANGELOG_MAX_LENGTH,
    }),
    createdBy: "user",
    files: requireFiles(body),
  });
  if (!result.ok) {
    return c.json({ error: result.reason }, 400);
  }

  // A first successful mirror makes the skill attachable, so the agents already
  // holding it need their `skills` array pushed.
  syncAgents(c, ctx.db, await listAgentIdsForSkill(ctx.db, skill.id));
  return c.json(
    {
      skill: toSkillView(result.skill),
      version: toSkillVersionView(result.version),
    },
    201
  );
});

skillsRoutes.post("/:slug/retry-sync", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const synced = await retrySkillSync(ctx, skill);
  syncAgents(c, ctx.db, await listAgentIdsForSkill(ctx.db, skill.id));
  return c.json({ skill: toSkillView(synced) });
});

skillsRoutes.delete("/:slug", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));

  // Agents first: they must stop referencing the skill before its mirror goes
  // away, and the API enforces no such ordering itself.
  const agentIds = await unassignSkillEverywhere(ctx.db, skill.id);
  await syncAgentSkillsWithAnthropic(ctx.db, c.env, agentIds);

  const anthropicError = await deleteSkillMirror(ctx, skill);
  await deleteSkillLocally(ctx.db, ctx.bucket, skill);
  return c.json({ anthropicError, removed: true });
});

// --- assignment -------------------------------------------------------------

skillsRoutes.get("/:slug/agents", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const agentIds = await listAgentIdsForSkill(ctx.db, skill.id);
  const agents = await getAgentsByIds(ctx.db, agentIds);
  const pins = await Promise.all(
    agents.map((agent) => getAgentSkill(ctx.db, skill.id, agent.id))
  );

  return c.json({
    agents: agents.map((agent, index) => ({
      avatar: agent.avatar,
      id: agent.id,
      name: agent.name,
      pinnedVersion: pins[index]?.pinnedVersion ?? null,
    })),
  });
});

skillsRoutes.post("/:slug/agents", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const body = await readJsonObject(c.req.raw);
  const agentId = requireString(body, "agentId");
  if (!(await getAgentById(ctx.db, c.get("workspace").id, agentId))) {
    throw notFound("Agent not found.");
  }

  const pinnedVersion = body.pinnedVersion ?? null;
  if (pinnedVersion !== null && typeof pinnedVersion !== "number") {
    throw badRequest(
      '"pinnedVersion" must be a version number, or null to track latest.'
    );
  }
  if (
    pinnedVersion !== null &&
    !(await getSkillVersion(ctx.db, skill.id, pinnedVersion))
  ) {
    throw badRequest(`This skill has no version ${pinnedVersion}.`);
  }

  try {
    const outcome = await assignSkill(ctx.db, {
      agentId,
      pinnedVersion,
      skillId: skill.id,
    });
    if (outcome !== "unchanged") {
      syncAgents(c, ctx.db, [agentId]);
    }
    return c.json({ assigned: true, outcome }, 201);
  } catch (error) {
    if (error instanceof SkillCapError) {
      throw badRequest(error.message);
    }
    throw error;
  }
});

skillsRoutes.delete("/:slug/agents/:agentId", async (c) => {
  const ctx = contextFor(c);
  const skill = await requireSkill(c, ctx, c.req.param("slug"));
  const agentId = c.req.param("agentId");
  if (!(await unassignSkill(ctx.db, skill.id, agentId))) {
    throw notFound("That agent is not assigned to this skill.");
  }
  syncAgents(c, ctx.db, [agentId]);
  return c.body(null, 204);
});
