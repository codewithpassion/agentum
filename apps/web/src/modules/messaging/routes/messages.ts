import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { notFound } from "#/api/validation";
import { createDb } from "#/db/client";
import { getThread } from "../service";

export const messagesRoutes = new Hono<ApiEnv>();

messagesRoutes.use("*", requireAuth);

/** The message is reached by bare id, so `getThread` proves its channel first. */
messagesRoutes.get("/:id/thread", async (c) => {
  const thread = await getThread(
    createDb(c.env.DB),
    c.get("workspace"),
    c.req.param("id")
  );
  if (!thread) {
    throw notFound("Message not found.");
  }
  return c.json(thread);
});
