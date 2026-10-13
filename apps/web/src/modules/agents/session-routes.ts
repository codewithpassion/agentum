import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { notFound } from "#/api/validation";
import { createDb } from "#/db/client";
import { AGENT_MODEL, isAvailableModel } from "#/modules/anthropic/config";
import { isSessionReusable } from "#/modules/anthropic/events";
import type { AnthropicGateway } from "#/modules/anthropic/gateway";
import { createGateway } from "#/modules/anthropic/service";
import { switchAgentSession } from "#/modules/router/retire";
import { requireOwner } from "#/modules/workspaces/require-workspace";
import { getAgentById } from "./service";
import {
  backfillFromGateway,
  getAgentSessionRow,
  listAgentSessionRows,
} from "./session-history";

/**
 * The owner's view of an agent's session history, and the way back into an
 * old session. Mounted under `/agents` by `routes.ts`; the gateway is a
 * parameter so a test can stand in for Anthropic.
 */

const SESSION_LIST_LIMIT = 50;
const CONFLICT = 409;

export type OpenSessionGateway = (
  env: Env,
  workspaceId: string
) => Promise<Pick<AnthropicGateway, "getSession" | "listSessions"> | null>;

export const createAgentSessionRoutes = (
  openGateway: OpenSessionGateway = (env, workspaceId) =>
    createGateway(createDb(env.DB), env, workspaceId)
) => {
  const routes = new Hono<ApiEnv>();

  /** Owner-only: the agent's session history, newest first. */
  routes.get("/:id/sessions", requireOwner, async (c) => {
    const db = createDb(c.env.DB);
    const workspaceId = c.get("workspace").id;
    const agent = await getAgentById(db, workspaceId, c.req.param("id"));
    if (!agent) {
      throw notFound("Agent not found.");
    }
    await backfillFromGateway(db, agent, await openGateway(c.env, workspaceId));
    const rows = await listAgentSessionRows(
      db,
      workspaceId,
      agent.id,
      SESSION_LIST_LIMIT
    );
    return c.json({
      sessions: rows.map((row) => ({
        current: row.endedAt === null,
        endedAt: row.endedAt?.toISOString() ?? null,
        endReason: row.endReason,
        id: row.anthropicSessionId,
        startedAt: row.startedAt.toISOString(),
        title: row.title,
      })),
    });
  });

  /**
   * Owner-only: makes a past session the agent's current one. Anthropic
   * decides whether it is still usable; the session keeps the tools it began
   * with.
   */
  routes.post("/:id/sessions/:sessionId/resume", requireOwner, async (c) => {
    const db = createDb(c.env.DB);
    const workspaceId = c.get("workspace").id;
    const agent = await getAgentById(db, workspaceId, c.req.param("id"));
    if (!agent) {
      throw notFound("Agent not found.");
    }
    const row = await getAgentSessionRow(
      db,
      workspaceId,
      agent.id,
      c.req.param("sessionId")
    );
    if (!row) {
      throw notFound("Session not found.");
    }
    const gateway = await openGateway(c.env, workspaceId);
    const status = gateway
      ? await gateway
          .getSession(row.anthropicSessionId)
          .catch(() => "terminated" as const)
      : "terminated";
    if (!isSessionReusable(status)) {
      return c.json({ error: "This session can't be resumed." }, CONFLICT);
    }
    await switchAgentSession(c.env, workspaceId, agent.id, {
      model:
        row.model ??
        (isAvailableModel(agent.model) ? agent.model : AGENT_MODEL),
      sessionId: row.anthropicSessionId,
      status,
    });
    return c.json({ resumed: true });
  });

  return routes;
};
