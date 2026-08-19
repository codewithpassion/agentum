import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  notFound,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listAgents,
  updateAgent,
} from "./service";

const NAME_MAX_LENGTH = 80;
const PROMPT_MAX_LENGTH = 20_000;

/** Agent names are unique, and that is the only unique column on the table. */
const isDuplicateName = isUniqueConstraintError;

export const agentsRoutes = new Hono<ApiEnv>();

agentsRoutes.use("*", requireAuth);

agentsRoutes.get("/", async (c) => {
  const agents = await listAgents(createDb(c.env.DB));
  return c.json({ agents });
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

  try {
    const agent = await createAgent(createDb(c.env.DB), input);
    return c.json({ agent }, 201);
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
  return c.json({ agent });
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

  try {
    const agent = await updateAgent(
      createDb(c.env.DB),
      c.req.param("id"),
      input
    );
    if (!agent) {
      throw notFound("Agent not found.");
    }
    return c.json({ agent });
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
  const deleted = await deleteAgent(createDb(c.env.DB), c.req.param("id"));
  if (!deleted) {
    throw notFound("Agent not found.");
  }
  return c.body(null, 204);
});
