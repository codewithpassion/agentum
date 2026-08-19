import { getAuth } from "@clerk/hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "./types";

/**
 * Gate for resource routers. `/api/health` and `/api/dev-login` stay open by
 * design, so this is mounted per-router rather than on `*`.
 */
export const requireAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const userId = getAuth(c)?.userId;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("userId", userId);
  await next();
});
