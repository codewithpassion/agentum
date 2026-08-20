import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  notFound,
  optionalBoolean,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import {
  resyncRostersWithAnthropic,
  syncAgentWithAnthropic,
} from "#/modules/anthropic/service";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
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

export const agentsRoutes = new Hono<ApiEnv>();

agentsRoutes.use("*", requireAuth);

agentsRoutes.get("/", async (c) => {
  const agents = await listAgents(createDb(c.env.DB));
  return c.json({ agents: agents.map(toAgentView) });
});

agentsRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const input = {
    avatar: optionalString(body, "avatar", { maxLength: NAME_MAX_LENGTH }),
    instructions:
      optionalString(body, "instructions", { maxLength: PROMPT_MAX_LENGTH }) ??
      "",
    name: requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }) ?? "",
  };

  const db = createDb(c.env.DB);

  try {
    // TODO(phase-2): replace with requireWorkspace context.
    const { agent, mcpToken } = await createAgent(
      db,
      DEFAULT_WORKSPACE_ID,
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
  const agent = await getAgentById(createDb(c.env.DB), c.req.param("id"));
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
    name: optionalString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }),
  };

  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  try {
    const agent = await updateAgent(db, id, input);
    if (!agent) {
      throw notFound("Agent not found.");
    }

    if (!optionalBoolean(body, "rotateMcpToken")) {
      // No new token, so no new MCP URL: the registered one still stands.
      inBackground(c, syncAgentWithAnthropic(db, c.env, id));
      return c.json({ agent: toAgentView(agent) });
    }

    const rotated = await rotateMcpToken(db, id);
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
  const deleted = await deleteAgent(db, c.req.param("id"));
  if (!deleted) {
    throw notFound("Agent not found.");
  }
  // The agent that left is still named in every other agent's roster. Its own
  // Anthropic agent is left alone: archiving is permanent and buys us nothing.
  inBackground(c, resyncRostersWithAnthropic(db, c.env));
  return c.body(null, 204);
});

/** What the agent rail polls when it has no socket for the agent's channel. */
agentsRoutes.get("/:id/status", async (c) => {
  const agent = await getAgentById(createDb(c.env.DB), c.req.param("id"));
  if (!agent) {
    throw notFound("Agent not found.");
  }
  return c.json({
    status: {
      agentId: agent.id,
      sessionId: agent.sessionId,
      status: agent.status,
      syncError: agent.syncError,
      syncStatus: agent.syncStatus,
    },
  });
});
