import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Composed } from "../compose.ts";
import { a2aWebhookRoutes } from "./a2a-webhooks.ts";
import type { AppEnv } from "./groups.ts";

/** The route over a service that records what it was asked, and says what the test tells it to. */
const appWith = (nudge: (taskId: string, token: string) => { ok: boolean }) => {
  const asked: [string, string][] = [];
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", {
      services: {
        a2aOutbound: {
          nudge: (taskId: string, token: string) => {
            asked.push([taskId, token]);
            return Promise.resolve(nudge(taskId, token));
          },
        },
      },
    } as unknown as Composed);
    await next();
  });
  app.route("/a2a", a2aWebhookRoutes());
  return { app, asked };
};

test("a push with the right token is answered 204", async () => {
  const { app, asked } = appWith(() => ({ ok: true }));

  const response = await app.request("/a2a/webhooks/aot_1/tok", {
    method: "POST",
  });

  expect(response.status).toBe(204);
  expect(asked).toEqual([["aot_1", "tok"]]);
});

test("a wrong token, an unknown task and a revoked connection all answer 401", async () => {
  const { app } = appWith(() => ({ ok: false }));

  const response = await app.request("/a2a/webhooks/aot_1/nope", {
    method: "POST",
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Not allowed." });
});

test("the body is ignored: a forged completion is not passed on", async () => {
  const { app, asked } = appWith(() => ({ ok: true }));
  const forged = JSON.stringify({
    task: { id: "rt-1", status: { state: "TASK_STATE_COMPLETED" } },
  });

  const response = await app.request("/a2a/webhooks/aot_1/tok", {
    body: forged,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  expect(response.status).toBe(204);
  // Only the path reaches the service.
  expect(asked).toEqual([["aot_1", "tok"]]);
});

test("a body that is not JSON, or huge, changes nothing", async () => {
  const { app } = appWith(() => ({ ok: true }));

  const response = await app.request("/a2a/webhooks/aot_1/tok", {
    body: "x".repeat(2_000_000),
    method: "POST",
  });

  expect(response.status).toBe(204);
});

test("only POST is a push", async () => {
  const { app } = appWith(() => ({ ok: true }));

  const response = await app.request("/a2a/webhooks/aot_1/tok");

  expect(response.status).toBe(404);
});
