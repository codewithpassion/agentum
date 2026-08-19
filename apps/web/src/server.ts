import { clerkMiddleware, getAuth } from "@clerk/hono";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.use("*", clerkMiddleware());

app.get("/api/health", (c) => {
  const auth = getAuth(c);
  return c.json({ status: "ok", userId: auth?.userId ?? null });
});

// Everything else is handled by TanStack Start (SSR pages, server functions, assets).
app.all("*", (c) => handler.fetch(c.req.raw));

export default app;
