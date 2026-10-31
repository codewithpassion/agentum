import { expect, test } from "bun:test";
import { a2aPairingRequests } from "@repo/db/schema/a2a";
import { Hono, type MiddlewareHandler } from "hono";
import { mountA2aRoutes } from "./a2a.ts";
import { createA2aFixture, textMessage } from "./a2a-fixture.ts";
import { mountA2aWebhooks } from "./a2a-webhooks.ts";
import type { AppEnv } from "./groups.ts";

const PAIRING_CODE = /Pairing code: [A-Z2-9]{8}/;

/** The app as server.ts mounts it: the webhook first, then the A2A server. */
const mounted = async () => {
  const f = await createA2aFixture();
  const agent = await f.publish("echo");
  await f.composed.services.connections.setPairingOpen(f.admin, {
    agentId: agent.agentId,
    open: true,
  });
  const app = new Hono<AppEnv>();
  const compose: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("composed", f.composed);
    await next();
  };
  mountA2aWebhooks(app, compose);
  mountA2aRoutes(app, compose);
  return { agent, app, f };
};

const post = (app: Hono<AppEnv>, path: string, bearer?: string) =>
  app.request(path, {
    body: JSON.stringify({
      task: { status: { state: "TASK_STATE_COMPLETED" } },
    }),
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    method: "POST",
  });

test("the webhook path answers 401 for a wrong token, and is not handled as pairing or a peer token", async () => {
  const { app, f } = await mounted();

  const wrong = await post(app, "/a2a/webhooks/aot_1/nope");
  const looksLikePairing = await post(app, "/a2a/webhooks/pair/activate");
  const withBearer = await post(
    app,
    "/a2a/webhooks/aot_1/nope",
    "x".repeat(40)
  );

  const bodies = await Promise.all(
    [wrong, looksLikePairing, withBearer].map((res) => res.json())
  );
  expect(
    [wrong, looksLikePairing, withBearer].map((res) => res.status)
  ).toEqual([401, 401, 401]);
  expect(bodies).toEqual(new Array(3).fill({ error: "Not allowed." }));
  expect(f.db.select().from(a2aPairingRequests).all()).toHaveLength(0);
});

test("an unknown token still gets the pairing code on SendMessage once the webhook is mounted", async () => {
  const { agent, app, f } = await mounted();
  const token = "ab".repeat(20);

  const res = await app.request(`/a2a/${agent.publicId}/rpc`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "SendMessage",
      params: textMessage("m1", "hi"),
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: {
      task: {
        status: { message: { parts: { text: string }[] }; state: string };
      };
    };
  };
  expect(body.result.task.status.state).toBe("TASK_STATE_REJECTED");
  expect(body.result.task.status.message.parts[0]?.text).toMatch(PAIRING_CODE);
  expect(f.db.select().from(a2aPairingRequests).all()).toHaveLength(1);
});

test("an unknown token with pairing off still gets 401, and other paths under /a2a still answer as before", async () => {
  const { agent, app, f } = await mounted();
  await f.composed.services.connections.setPairingOpen(f.admin, {
    agentId: agent.agentId,
    open: false,
  });

  const rpc = await app.request(`/a2a/${agent.publicId}/rpc`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "SendMessage",
      params: textMessage("m1", "hi"),
    }),
    headers: {
      Authorization: `Bearer ${"cd".repeat(20)}`,
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const nowhere = await app.request("/a2a/webhooks/aot_1/tok");

  expect(rpc.status).toBe(401);
  expect(nowhere.status).toBe(404);
});
