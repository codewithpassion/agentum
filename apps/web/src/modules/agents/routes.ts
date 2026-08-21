import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalBoolean,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { AVAILABLE_MODELS, isAvailableModel } from "#/modules/anthropic/config";
import {
  resyncRostersWithAnthropic,
  syncAgentWithAnthropic,
} from "#/modules/anthropic/service";
import { deleteSlackAppForAgent } from "#/modules/bridges/slack/apps";
import {
  countPendingQuestionsByAgent,
  countPendingQuestionsForAgent,
} from "#/modules/questions/service";
import { mcpUrlForToken } from "./mcp-token";
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listAgents,
  rotateMcpToken,
  toAgentView,
  updateAgent,
} from "./service";

const NAME_MAX_LENGTH = 80;
const PROMPT_MAX_LENGTH = 20_000;

/**
 * A unique-constraint failure on this insert can only be the name: the other
 * unique column, `mcp_token_hash`, holds a freshly generated secret.
 */
const isDuplicateName = isUniqueConstraintError;

/**
 * The agent's model, validated against the catalog. Three answers, all of them
 * meaningful: absent leaves it as it is, `null` puts the agent back on the
 * workspace default, and a string has to be one we actually offer.
 */
const optionalModel = (
  body: Record<string, unknown>
): string | null | undefined => {
  const value = body.model;
  if (value === undefined) {
    return;
  }
  if (value === null) {
    return null;
  }
  if (!isAvailableModel(value)) {
    throw badRequest(
      `"model" must be one of: ${AVAILABLE_MODELS.map((model) => model.id).join(", ")}.`
    );
  }
  return value;
};

/**
 * Registration with Anthropic is best-effort and must never hold up a response
 * or fail an edit: an unreachable API leaves the agent with `syncStatus:
 * "error"`, which the agent rail shows, and the next edit retries.
 */
const inBackground = (context: Context<ApiEnv>, work: Promise<unknown>) => {
  const settled = work.catch(() => {
    // Every failure path already records itself on the agent row.
  });
  try {
    context.executionCtx.waitUntil(settled);
  } catch {
    // No execution context (a direct fetch in a test): let it run detached.
  }
};

/**
 * Mounted under `/api/w/:slug`, so `requireWorkspace` has already resolved the
 * workspace and proved the caller belongs to it. Every query below carries
 * `c.get("workspace").id`, including the ones addressed by a bare `:id`.
 */
export const agentsRoutes = new Hono<ApiEnv>();

agentsRoutes.use("*", requireAuth);

agentsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const [agents, pending] = await Promise.all([
    listAgents(db, workspaceId),
    // One grouped count for the whole rail, however many agents it shows.
    countPendingQuestionsByAgent(db, workspaceId),
  ]);
  return c.json({
    agents: agents.map((agent) => ({
      ...toAgentView(agent),
      pendingQuestions: pending.get(agent.id) ?? 0,
    })),
  });
});

agentsRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const input = {
    avatar: optionalString(body, "avatar", { maxLength: NAME_MAX_LENGTH }),
    instructions:
      optionalString(body, "instructions", { maxLength: PROMPT_MAX_LENGTH }) ??
      "",
    model: optionalModel(body),
    name: requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }) ?? "",
  };

  const db = createDb(c.env.DB);

  try {
    const { agent, mcpToken } = await createAgent(
      db,
      c.get("workspace").id,
      input
    );
    // The only time the plaintext token exists: the client shows it once, and
    // it is also the only moment we can hand Anthropic this agent's MCP URL.
    const mcpUrl = mcpUrlForToken(c.env.PUBLIC_APP_URL, c.req.url, mcpToken);
    inBackground(c, syncAgentWithAnthropic(db, c.env, agent.id, { mcpUrl }));

    return c.json({ agent: toAgentView(agent), mcpUrl }, 201);
  } catch (error) {
    if (isDuplicateName(error)) {
      return c.json(
        { error: `An agent named "${input.name}" already exists.` },
        409
      );
    }
    throw error;
  }
});

agentsRoutes.get("/:id", async (c) => {
  const agent = await getAgentById(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id")
  );
  if (!agent) {
    throw notFound("Agent not found.");
  }
  return c.json({ agent: toAgentView(agent) });
});

agentsRoutes.patch("/:id", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const input = {
    avatar: optionalString(body, "avatar", { maxLength: NAME_MAX_LENGTH }),
    instructions: optionalString(body, "instructions", {
      maxLength: PROMPT_MAX_LENGTH,
    }),
    model: optionalModel(body),
    name: optionalString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }),
  };

  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const workspaceId = c.get("workspace").id;

  try {
    const agent = await updateAgent(db, workspaceId, id, input);
    if (!agent) {
      throw notFound("Agent not found.");
    }

    if (!optionalBoolean(body, "rotateMcpToken")) {
      // No new token, so no new MCP URL: the registered one still stands.
      inBackground(c, syncAgentWithAnthropic(db, c.env, id));
      return c.json({ agent: toAgentView(agent) });
    }

    const rotated = await rotateMcpToken(db, workspaceId, id);
    if (!rotated) {
      throw notFound("Agent not found.");
    }
    const mcpUrl = mcpUrlForToken(
      c.env.PUBLIC_APP_URL,
      c.req.url,
      rotated.mcpToken
    );
    inBackground(c, syncAgentWithAnthropic(db, c.env, id, { mcpUrl }));

    return c.json({ agent: toAgentView(rotated.agent), mcpUrl });
  } catch (error) {
    if (isDuplicateName(error)) {
      return c.json(
        { error: `An agent named "${input.name}" already exists.` },
        409
      );
    }
    throw error;
  }
});

agentsRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const id = c.req.param("id");
  const deleted = await deleteAgent(db, workspaceId, id);
  if (!deleted) {
    throw notFound("Agent not found.");
  }
  // An agent's Slack app belongs to it, and takes its bridges along: left
  // behind, it would be an events URL Slack keeps posting to for an agent that
  // no longer exists, with no screen anywhere that could disconnect it.
  await deleteSlackAppForAgent(db, workspaceId, id);
  // The agent that left is still named in every other agent's roster - every
  // other agent *of this workspace*, which is the only roster it was ever in.
  // Its own Anthropic agent is left alone: archiving is permanent and buys us
  // nothing.
  inBackground(c, resyncRostersWithAnthropic(db, c.env, workspaceId));
  return c.body(null, 204);
});

/** What the agent rail polls when it has no socket for the agent's channel. */
agentsRoutes.get("/:id/status", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const agent = await getAgentById(db, workspaceId, c.req.param("id"));
  if (!agent) {
    throw notFound("Agent not found.");
  }
  return c.json({
    status: {
      agentId: agent.id,
      // How many questions this agent is waiting on - the rail's badge rides
      // the poll it already makes.
      pendingQuestions: await countPendingQuestionsForAgent(
        db,
        workspaceId,
        agent.id
      ),
      sessionId: agent.sessionId,
      status: agent.status,
      syncError: agent.syncError,
      syncStatus: agent.syncStatus,
    },
  });
});
