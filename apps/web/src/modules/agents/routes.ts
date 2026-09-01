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
import { createDb, type Db } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { AVAILABLE_MODELS, isAvailableModel } from "#/modules/anthropic/config";
import {
  resyncRostersWithAnthropic,
  syncAgentWithAnthropic,
} from "#/modules/anthropic/service";
import { deleteSlackAppForAgent } from "#/modules/bridges/slack/apps";
import { getHost } from "#/modules/computer/hosts";
import {
  onAgentComputerCreated,
  onAgentComputerDeleted,
} from "#/modules/computer/lifecycle";
import {
  countPendingQuestionsByAgent,
  countPendingQuestionsForAgent,
} from "#/modules/questions/service";
import { isCloudflareModelShaped } from "#/modules/runner/models";
import { mcpUrlForToken } from "./mcp-token";
import {
  AGENT_COMPUTERS,
  AGENT_RUNTIMES,
  type AgentComputer,
  type AgentRuntime,
  isAgentComputer,
  isAgentRuntime,
} from "./schema";
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listAgentIdsForComputerHost,
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
 * The agent's model, validated for its runtime. Three answers, all of them
 * meaningful: absent leaves it as it is, `null` puts the agent back on the
 * runtime's default, and a string has to be one the runtime can run - a
 * catalog id for Managed Agents, a Workers AI or AI Gateway id for Cloudflare.
 */
const optionalModel = (
  body: Record<string, unknown>,
  runtime: AgentRuntime
): string | null | undefined => {
  const value = body.model;
  if (value === undefined) {
    return;
  }
  if (value === null) {
    return null;
  }
  if (runtime === "cloudflare") {
    if (!isCloudflareModelShaped(value)) {
      throw badRequest(
        '"model" must be a Workers AI model id (@cf/...) or an AI Gateway {provider}/{model} reference.'
      );
    }
    return value;
  }
  if (!isAvailableModel(value)) {
    throw badRequest(
      `"model" must be one of: ${AVAILABLE_MODELS.map((model) => model.id).join(", ")}.`
    );
  }
  return value;
};

/** Where the agent runs; fixed at creation, so only the create route asks. */
const optionalRuntime = (body: Record<string, unknown>): AgentRuntime => {
  const value = body.runtime;
  if (value === undefined || value === null) {
    return "managed";
  }
  if (!isAgentRuntime(value)) {
    throw badRequest(`"runtime" must be one of: ${AGENT_RUNTIMES.join(", ")}.`);
  }
  return value;
};

/** Where the agent's computer runs; fixed at creation, like the runtime. */
const optionalComputer = (body: Record<string, unknown>): AgentComputer => {
  const value = body.computer;
  if (value === undefined || value === null) {
    return "cloudflare";
  }
  if (!isAgentComputer(value)) {
    throw badRequest(
      `"computer" must be one of: ${AGENT_COMPUTERS.join(", ")}.`
    );
  }
  return value;
};

/**
 * The host the agent's computer runs on, checked against the computer it was
 * asked for. Everything here is a 400 rather than a 404: the client chose both
 * halves of an invalid pair, and which half is wrong is worth saying.
 *
 * A self-hosted host takes one agent (the plan, §3): the daemon serves one
 * filesystem, so a second agent on it would share the first one's files.
 */
const resolveComputerHost = async (
  db: Db,
  workspaceId: string,
  body: Record<string, unknown>,
  computer: AgentComputer
): Promise<string | null> => {
  const hostId = optionalString(body, "computerHostId");
  if (computer === "cloudflare") {
    if (hostId) {
      throw badRequest(
        '"computerHostId" applies to the fly and self_hosted computers only.'
      );
    }
    return null;
  }
  if (!hostId) {
    throw badRequest(
      `"computerHostId" is required when "computer" is ${computer}.`
    );
  }

  const host = await getHost(db, workspaceId, hostId);
  if (!host) {
    throw badRequest(
      '"computerHostId" must be a computer host in this workspace.'
    );
  }
  if (host.kind !== computer) {
    throw badRequest(
      `"${host.name}" is a ${host.kind} host, but "computer" is ${computer}.`
    );
  }
  if (
    host.kind === "self_hosted" &&
    (await listAgentIdsForComputerHost(db, host.id)).length > 0
  ) {
    throw badRequest(
      `"${host.name}" already runs an agent. A self-hosted host runs one agent; start a second container for another.`
    );
  }
  return host.id;
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
  const runtime = optionalRuntime(body);
  const computer = optionalComputer(body);
  const db = createDb(c.env.DB);
  const input = {
    avatar: optionalString(body, "avatar", { maxLength: NAME_MAX_LENGTH }),
    computer,
    computerHostId: await resolveComputerHost(
      db,
      c.get("workspace").id,
      body,
      computer
    ),
    instructions:
      optionalString(body, "instructions", { maxLength: PROMPT_MAX_LENGTH }) ??
      "",
    model: optionalModel(body, runtime),
    name: requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    runtime,
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }) ?? "",
  };

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
    // A remote computer has to be created before the agent can use it - a Fly
    // machine and its volume. Backgrounded for the same reason the Anthropic
    // registration is: it is seconds of somebody else's API, and its failures
    // land on the host rather than on this response.
    inBackground(c, onAgentComputerCreated(db, c.env, agent));

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
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const workspaceId = c.get("workspace").id;

  // The runtime decides what a valid model is, and it cannot change: the two
  // runtimes keep incompatible session state, so a switch would strand one.
  const existing = await getAgentById(db, workspaceId, id);
  if (!existing) {
    throw notFound("Agent not found.");
  }
  if (body.runtime !== undefined && body.runtime !== existing.runtime) {
    throw badRequest(
      '"runtime" is fixed when an agent is created. Create a new agent to run it elsewhere.'
    );
  }
  // Same rule, different reason: the computer's files live in the backend it
  // was created on, so moving it would be a migration rather than an edit.
  if (body.computer !== undefined && body.computer !== existing.computer) {
    throw badRequest(
      '"computer" is fixed when an agent is created. Create a new agent to run its computer elsewhere.'
    );
  }
  if (
    body.computerHostId !== undefined &&
    body.computerHostId !== existing.computerHostId
  ) {
    throw badRequest(
      '"computerHostId" is fixed when an agent is created. Create a new agent to move its computer.'
    );
  }

  const input = {
    avatar: optionalString(body, "avatar", { maxLength: NAME_MAX_LENGTH }),
    instructions: optionalString(body, "instructions", {
      maxLength: PROMPT_MAX_LENGTH,
    }),
    model: optionalModel(body, existing.runtime),
    name: optionalString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    soul: optionalString(body, "soul", { maxLength: PROMPT_MAX_LENGTH }),
  };

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
  // Read before deleting: the computer teardown needs the row's `computer`,
  // `computerHostId` and `computerRef`, and after the delete they are gone.
  const agent = await getAgentById(db, workspaceId, id);
  const deleted = agent ? await deleteAgent(db, workspaceId, id) : false;
  if (!(agent && deleted)) {
    throw notFound("Agent not found.");
  }
  // Whatever the agent's computer backend created for it - a Fly machine and
  // its volume - goes with it. A no-op on the other two backends.
  await onAgentComputerDeleted(db, c.env, agent);
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
