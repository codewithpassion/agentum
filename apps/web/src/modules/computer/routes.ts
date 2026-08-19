import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { badRequest, notFound } from "#/api/validation";
import { createDb } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import { getAgentById } from "#/modules/agents/service";
import { summarizeWrite } from "./activity";
import { type AgentComputerClient, createComputerClient } from "./client";
import { MAX_FILE_BYTES, MAX_READ_BYTES, validatePath } from "./paths";

/**
 * What the right rail's Files tab reads and writes. Mounted on `/api/agents`
 * after the agents router, the way `bridgeRoutes` hangs off `/api/channels`.
 * The agent-facing half of the same computer is in `modules/mcp/tools`.
 */

const PAYLOAD_TOO_LARGE = 413;
const UPLOAD_DIRECTORY = "/uploads";

const clientFor = async (
  env: Env,
  agentId: string
): Promise<AgentComputerClient> => {
  const db = createDb(env.DB);
  if (!(await getAgentById(db, agentId))) {
    throw notFound("Agent not found.");
  }
  return createComputerClient(db, env, agentId);
};

export const computerRoutes = new Hono<ApiEnv>();

computerRoutes.use("*", requireAuth);

computerRoutes.get("/:id/computer/ls", async (c) => {
  const computer = await clientFor(c.env, c.req.param("id"));
  const result = await computer.listDir(c.req.query("path") ?? "/");
  if (!result.ok) {
    throw badRequest(result.reason);
  }
  return c.json({ entries: result.entries });
});

computerRoutes.get("/:id/computer/file", async (c) => {
  const path = c.req.query("path");
  if (!path) {
    throw badRequest('A "path" query parameter is required.');
  }

  const computer = await clientFor(c.env, c.req.param("id"));
  const result = await computer.readFile(path, MAX_READ_BYTES);
  if (!result.ok) {
    throw badRequest(result.reason);
  }
  return c.json({ content: result.content, path, size: result.size });
});

/** The user putting a file onto the agent's computer, from the Files tab. */
computerRoutes.post("/:id/computer/file", async (c) => {
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > MAX_FILE_BYTES) {
    return c.json({ error: "The file is too large." }, PAYLOAD_TOO_LARGE);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw badRequest('Expected a multipart "file" field.');
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: "The file is too large." }, PAYLOAD_TOO_LARGE);
  }

  const requested = form.get("path");
  const target = validatePath(
    typeof requested === "string" && requested.length > 0
      ? requested
      : `${UPLOAD_DIRECTORY}/${file.name}`
  );
  if (!target.ok) {
    throw badRequest(target.reason);
  }

  const agentId = c.req.param("id");
  const db = createDb(c.env.DB);
  if (!(await getAgentById(db, agentId))) {
    throw notFound("Agent not found.");
  }

  // Straight to the Durable Object: an upload is bytes, not the text the
  // client's `writeFile` validates, and it is attributed to the user rather
  // than to the agent.
  const stub = c.env.AGENT_COMPUTER.get(
    c.env.AGENT_COMPUTER.idFromName(agentId)
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await stub.writeFile(target.path, bytes);
  if (!result.ok) {
    throw badRequest(result.reason);
  }

  await logActivity(db, {
    agentId,
    detail: {
      created: result.created,
      path: target.path,
      size: result.size,
      uploadedByUser: true,
    },
    kind: "computer.write",
    summary: `${summarizeWrite({
      created: result.created,
      path: target.path,
      size: result.size,
    })} - uploaded by the user`,
  });

  return c.json({ file: { path: target.path, size: result.size } }, 201);
});
