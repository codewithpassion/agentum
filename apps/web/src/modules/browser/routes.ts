import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { notFound, parsePositiveInt } from "#/api/validation";
import { createDb } from "#/db/client";
// The screenshot list pages on the same `(createdAt, id)` cursor as the
// activity feed, so it decodes one the same way.
import { decodeActivityCursor } from "#/modules/activity/service";
import { getAgentById } from "#/modules/agents/service";
import { getScreenshot, listScreenshots, readStatus } from "./service";

/**
 * What the right rail's Screen tab reads: the screenshots an agent's browser
 * has taken, the images themselves, and whether it has a session open. Mounted
 * on `/api/agents` after the agents router, the way `computerRoutes` is.
 *
 * The agent-facing half of the same browser is in `modules/mcp/tools`.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const browserRoutes = new Hono<ApiEnv>();

browserRoutes.use("*", requireAuth);

const requireAgent = async (
  env: Env,
  workspaceId: string,
  agentId: string
): Promise<void> => {
  if (!(await getAgentById(createDb(env.DB), workspaceId, agentId))) {
    throw notFound("Agent not found.");
  }
};

browserRoutes.get("/:id/browser/screenshots", async (c) => {
  const workspace = c.get("workspace");
  const agentId = c.req.param("id");
  await requireAgent(c.env, workspace.id, agentId);

  const page = await listScreenshots(createDb(c.env.DB), {
    agentId,
    cursor: decodeActivityCursor(c.req.query("before")),
    limit: parsePositiveInt(c.req.query("limit"), {
      fallback: DEFAULT_LIMIT,
      max: MAX_LIMIT,
    }),
    workspaceSlug: workspace.slug,
  });
  return c.json(page);
});

browserRoutes.get("/:id/browser/screenshots/:screenshotId", async (c) => {
  const db = createDb(c.env.DB);
  // The agent is the screenshot's parent and the only thing carrying a
  // workspace, so it is resolved scoped before the row is read.
  await requireAgent(c.env, c.get("workspace").id, c.req.param("id"));
  const screenshot = await getScreenshot(db, c.req.param("screenshotId"));
  // Addressed by id rather than by R2 key: the key contains slashes, and an
  // agent id in the path that the row disagrees with must not resolve.
  if (!screenshot || screenshot.agentId !== c.req.param("id")) {
    throw notFound("Screenshot not found.");
  }

  const object = await c.env.ATTACHMENTS.get(screenshot.r2Key);
  if (!object) {
    throw notFound("Screenshot content is missing.");
  }

  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${screenshot.id}.png"`,
      "Content-Length": String(screenshot.size),
      "Content-Type": "image/png",
    },
  });
});

browserRoutes.get("/:id/browser/status", async (c) => {
  const agentId = c.req.param("id");
  await requireAgent(c.env, c.get("workspace").id, agentId);
  return c.json(await readStatus(createDb(c.env.DB), c.env, agentId));
});
