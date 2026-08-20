import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { notFound, parsePositiveInt } from "#/api/validation";
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { decodeActivityCursor, listActivity } from "./service";

/**
 * `GET /api/agents/:id/activity` - what the right rail's Activity tab reads.
 * Mounted on `/api/agents` after the agents router, the way `bridgeRoutes`
 * hangs off `/api/channels`.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const agentActivityRoutes = new Hono<ApiEnv>();

agentActivityRoutes.use("*", requireAuth);

agentActivityRoutes.get("/:id/activity", async (c) => {
  const db = createDb(c.env.DB);
  const agentId = c.req.param("id");
  if (!(await getAgentById(db, c.get("workspace").id, agentId))) {
    throw notFound("Agent not found.");
  }

  const page = await listActivity(db, {
    agentId,
    cursor: decodeActivityCursor(c.req.query("before")),
    limit: parsePositiveInt(c.req.query("limit"), {
      fallback: DEFAULT_LIMIT,
      max: MAX_LIMIT,
    }),
  });
  return c.json(page);
});
