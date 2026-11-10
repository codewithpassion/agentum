import { Hono } from "hono";

/** Liveness only. It says nothing about who is asking. */
export const healthRoutes = new Hono().get("/api/health", (c) =>
  c.json({ status: "ok" })
);
