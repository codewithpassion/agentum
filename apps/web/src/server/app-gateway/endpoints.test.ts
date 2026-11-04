import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { fakePorts } from "./fakes.ts";
import { mountEndpointRoutes } from "./endpoints.ts";
import type { AppRuntimeInput } from "./ports.ts";

const setup = () => {
  const active = new Set(["approved"]);
  const seen: AppRuntimeInput[] = [];
  const keys: string[] = [];
  const logs: string[] = [];
  let limited = false;
  const app = new Hono<AppEnv>();
  mountEndpointRoutes(app, {
    limiter: () => ({ limit: async ({ key }) => { keys.push(key); return { success: !limited }; } }),
    wiring: () => ({
      endpoints: {
        resolve: async (id) => active.has(id) ? { artifactId: "a", versionId: "v", workspaceId: "w", endpointId: id } : null,
        recordCall: async (_id, _meta, outcome) => { logs.push(outcome); },
      },
      ports: fakePorts(),
      declaresHosts: async () => true,
      requestMeta: async () => ({ ipPrefix: null, place: null, userAgent: null, visitorHash: "h" }),
      runtime: { handle: async (input) => { seen.push(input); return new Response(input.request.body, { headers: { "set-cookie": "evil", "content-type": "application/octet-stream" } }); } },
    }),
  });
  return { app, seen, keys, logs, active, limit: () => { limited = true; } };
};

test("unknown, disabled, missing and pending grant ids have the same fixed 404", async () => {
  const { app, seen } = setup();
  for (const id of ["unknown", "disabled", "missing-grant", "pending"]) {
    const response = await app.request(`/hooks/${id}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.");
  }
  expect(seen).toHaveLength(0);
});

test("raw bytes, suffix, query and authorization reach endpoint app; headers are filtered", async () => {
  const { app, seen, logs } = setup();
  const bytes = new Uint8Array([0, 255, 13, 10, 123, 32, 125]);
  const response = await app.request("/hooks/approved/discord?x=%2F&x=2", { method: "POST", body: bytes, headers: { authorization: "Bearer bot", cookie: "session=secret", "CF-Connecting-IP": "1.2.3.4", "x-forwarded-for": "private" } });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const request = seen[0]!.request;
  expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/discord?x=%2F&x=2");
  expect(request.headers.get("authorization")).toBe("Bearer bot");
  for (const name of ["cookie", "cf-connecting-ip", "x-forwarded-for"]) expect(request.headers.has(name)).toBe(false);
  expect(seen[0]!.host.viewer).toEqual({ kind: "endpoint", endpointId: "approved" });
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("content-security-policy")).toBe(true);
  expect(logs).toEqual(["ok"]);
});

test("root and OPTIONS reach app; rotation closes old id; endpoint and IP limits give 429", async () => {
  const h = setup();
  expect((await h.app.request("/hooks/approved", { method: "OPTIONS" })).status).toBe(200);
  expect(new URL(h.seen[0]!.request.url).pathname).toBe("/");
  h.active.delete("approved"); h.active.add("rotated");
  expect((await h.app.request("/hooks/approved")).status).toBe(404);
  expect((await h.app.request("/hooks/rotated")).status).toBe(200);
  h.limit();
  expect((await h.app.request("/hooks/rotated", { headers: { "CF-Connecting-IP": "1.2.3.4" } })).status).toBe(429);
  expect(h.keys).toContain("api:endpoint:rotated");
  expect(h.keys.some((key) => key.startsWith("api:endpoint:rotated:ip:"))).toBe(true);
  expect(h.logs.at(-1)).toBe("rate_limited");
});
