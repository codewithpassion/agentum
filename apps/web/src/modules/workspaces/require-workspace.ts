import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "#/api/types";
import { createDb } from "#/db/client";
import { findMembership, getWorkspaceBySlug } from "./service";

/**
 * The tenant gate for everything under `/api/w/:slug`, mounted after
 * `requireAuth`. It resolves the slug, checks the caller's membership, and puts
 * both on the context so no handler has to repeat the lookup.
 *
 * It lives here, next to the tables it queries, rather than in `src/api/`: this
 * module owns the workspace row and the rule for reaching one.
 *
 * **An unknown slug and a workspace the caller does not belong to answer the
 * same 404.** A 403 would confirm that a workspace exists to somebody with no
 * business knowing it does.
 */
export const requireWorkspace = createMiddleware<ApiEnv>(async (c, next) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const workspace = slug ? await getWorkspaceBySlug(db, slug) : undefined;
  const member = workspace
    ? await findMembership(db, workspace.id, c.get("userId"))
    : undefined;

  if (!(workspace && member)) {
    return c.json({ error: "Workspace not found." }, 404);
  }

  c.set("member", member);
  c.set("workspace", workspace);
  await next();
});

/**
 * Owner-only routes: workspace rename/delete and member management. Unlike
 * `requireWorkspace` this answers 403 - the caller is a member, so the
 * workspace's existence is not a secret from them.
 */
export const requireOwner = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.get("member").role !== "owner") {
    return c.json({ error: "Only workspace owners can do that." }, 403);
  }
  await next();
});
