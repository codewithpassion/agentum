import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "bun";
import { handleEndpointRoute } from "../../web/src/server/app-gateway/endpoint-handler.ts";

const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url)
);
const { Miniflare, convertV4MiniflareOptions } = await import(
  requireWeb.resolve("miniflare")
);
let flare: InstanceType<typeof Miniflare>;
let base: string;

const app = `export default {
 async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path === '/throw') throw new Error('fixture failure');
  if (path === '/background') {
   ctx.waitUntil((async () => { await new Promise(r => setTimeout(r, 300)); await env.AGENTUM.setItem('shared', 'done', 'yes'); })());
   return new Response('accepted', { status: 202 });
  }
  if (path === '/background-error') { ctx.waitUntil(new Promise((_, r) => setTimeout(() => r(new Error('background failure')), 100))); return new Response('accepted'); }
  if (path === '/host') {
   await env.AGENTUM.setItem('shared', 'key', 'value');
   return Response.json({ who: await env.AGENTUM.whoami(), value: await env.AGENTUM.getItem('shared', 'key'), run: await env.AGENTUM.startRun({ agent: 'agent', text: 'hello' }), denied: await env.AGENTUM.callTool('x', {}).then(() => false, () => true) });
  }
  if (path === '/outbound') { const response = await fetch('https://approved.test/path'); return Response.json({ allowed: await response.json(), blocked: (await fetch('https://blocked.test/')).status }); }
  if (path === '/read') return new Response(await env.AGENTUM.getItem('shared', 'done'));
  return new Response(await request.arrayBuffer(), { status: 201, headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'evil', 'x-path': request.url } });
 }
};`;

beforeAll(async () => {
  const scripts = await Promise.all(
    ["./index.ts", "./main-fixture.ts"].map(async (path) => {
      const result = await build({
        entrypoints: [fileURLToPath(new URL(path, import.meta.url))],
        external: ["cloudflare:workers"],
        format: "esm",
        target: "node",
      });
      if (!result.success) {
        throw new Error(result.logs.map(String).join("\n"));
      }
      return result.outputs[0]?.text();
    })
  );
  flare = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          compatibilityDate: "2026-08-19",
          d1Databases: ["DB"],
          modules: true,
          name: "front",
          r2Buckets: ["FILES"],
          ratelimits: {
            APP_API_LIMIT: {
              namespace_id: "2004",
              simple: { limit: 300, period: 60 },
            },
          },
          script: scripts[0],
          serviceBindings: { MAIN: { entrypoint: "HooksMain", name: "main" } },
          workerLoaders: { LOADER: {} },
        },
        {
          compatibilityDate: "2026-08-19",
          modules: true,
          name: "main",
          // Keep the upstream in workerd: a JS callback uses Miniflare's
          // Bun-hosted HTTP loopback, which can lose connections after disposal
          // of the gate fixture, even on a direct MAIN fetch without app RPC.
          outboundService: "upstream",
          script: scripts[1],
        },
        {
          compatibilityDate: "2026-08-19",
          modules: true,
          name: "upstream",
          script: `export default {
            fetch(request) {
              return Response.json({
                authorized: request.headers.get('authorization') === 'Bot fixture-secret',
              });
            },
          };`,
        },
      ],
    })
  );
  const db = await flare.getD1Database("DB", "front");
  await db.exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT, current_version_id TEXT, deleted_at TEXT);
CREATE TABLE artifact_versions (id TEXT PRIMARY KEY, artifact_id TEXT, workspace_id TEXT, status TEXT);
CREATE TABLE artifact_endpoints (id TEXT PRIMARY KEY, artifact_id TEXT, workspace_id TEXT, name TEXT, disabled_at TEXT);
CREATE TABLE artifact_grants (id TEXT PRIMARY KEY, version_id TEXT, workspace_id TEXT, kind TEXT, target TEXT, status TEXT);
CREATE TABLE artifact_view_salts (workspace_id TEXT, day TEXT, salt TEXT, PRIMARY KEY(workspace_id, day));
CREATE TABLE artifact_views (id TEXT PRIMARY KEY, artifact_id TEXT, workspace_id TEXT, version_id TEXT, country TEXT, created_at TEXT, duration_ms INTEGER, ip_prefix TEXT, outcome TEXT, status_code INTEGER, surface TEXT, tool_key TEXT, user_agent TEXT, visitor_hash TEXT, asn TEXT, as_org TEXT, city TEXT, guest_id TEXT, referrer_host TEXT, region TEXT, share_id TEXT, user_id TEXT);
INSERT INTO artifacts VALUES ('a', 'w', 'app', 'v', NULL);
INSERT INTO artifact_versions VALUES ('v', 'a', 'w', 'published');
INSERT INTO artifact_endpoints VALUES ('enabled', 'a', 'w', 'fixture', NULL), ('disabled', 'a', 'w', 'fixture', '2026-01-01');
INSERT INTO artifact_grants VALUES ('g', 'v', 'w', 'endpoint', 'fixture', 'approved'), ('h', 'v', 'w', 'host', 'approved.test', 'approved');`);
  const bucket = await flare.getR2Bucket("FILES", "front");
  await bucket.put(
    "w/artifact-manifests/v.json",
    JSON.stringify({
      entry: "index.html",
      files: {
        "index.html": {
          contentType: "text/html",
          sha256: "0".repeat(64),
          size: 0,
        },
        "server/index.js": {
          contentType: "text/javascript",
          sha256: "1".repeat(64),
          size: app.length,
        },
      },
    })
  );
  await bucket.put(`w/artifact-blobs/${"1".repeat(64)}`, app);
  base = String(await flare.ready);
}, 60_000);

afterAll(async () => {
  await flare?.dispose();
});
const call = (path: string, init?: RequestInit) =>
  fetch(new URL(`/hooks/${path}`, base), init);
const state = async () => {
  const main = await flare.getWorker("main");
  return (await main.fetch("https://main.test/state")).json() as Promise<{
    calls: number;
    errors: { entry: string; message: string }[];
  }>;
};

test("front preserves raw bytes, filters headers, logs status/duration and never calls MAIN for a plain app", async () => {
  const before = (await state()).calls;
  const bytes = new TextEncoder().encode('{ "text": "é" }\r\n');
  const started = performance.now();
  const response = await call("enabled/raw?q=1", {
    body: bytes,
    method: "POST",
  });
  expect(response.status).toBe(201);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  console.log(
    "hooks production front cold response ms",
    Math.round(performance.now() - started)
  );
  expect(performance.now() - started).toBeLessThan(1000);
  const warmStarted = performance.now();
  const warm = await call("enabled/raw?q=1", { body: bytes, method: "POST" });
  expect(new Uint8Array(await warm.arrayBuffer())).toEqual(bytes);
  console.log(
    "hooks production front warm response ms",
    Math.round(performance.now() - warmStarted)
  );
  expect(performance.now() - warmStarted).toBeLessThan(1000);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await state()).calls).toBe(before);
  await new Promise((r) => setTimeout(r, 100));
  const db = await flare.getD1Database("DB", "front");
  const row = await db
    .prepare("SELECT * FROM artifact_views WHERE status_code = 201")
    .first();
  expect(row?.surface).toBe("live_call");
  expect(row?.tool_key).toBe("endpoint:fixture");
  expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
});

test("AGENTUM and outbound policy cross MAIN, including storage, startRun, restrictions and secret filling", async () => {
  const response = await call("enabled/host");
  expect(await response.json()).toEqual({
    denied: true,
    run: { runId: "run" },
    value: "value",
    who: { dataMode: null, viewer: "endpoint" },
  });
  expect(await (await call("enabled/outbound")).json()).toEqual({
    allowed: { authorized: true },
    blocked: 403,
  });
});

test("response precedes background work, whose AGENTUM stub remains usable", async () => {
  const started = performance.now();
  const response = await call("enabled/background");
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("accepted");
  expect(performance.now() - started).toBeLessThan(250);
  await new Promise((r) => setTimeout(r, 500));
  expect(await (await call("enabled/read")).text()).toBe("yes");
});

test("app fetch and background errors reach the existing error recorder", async () => {
  expect((await call("enabled/throw")).status).toBe(502);
  expect((await call("enabled/background-error")).status).toBe(200);
  await new Promise((r) => setTimeout(r, 300));
  expect((await state()).errors).toEqual(
    expect.arrayContaining([
      { entry: "fetch fixture", message: "fixture failure" },
      { entry: "waitUntil fixture", message: "background failure" },
    ])
  );
});

test("unknown, disabled and unapproved endpoints return 404 without access rows", async () => {
  const before = await (await flare.getD1Database("DB", "front"))
    .prepare("SELECT count(*) AS n FROM artifact_views")
    .first();
  expect((await call("unknown")).status).toBe(404);
  expect((await call("disabled")).status).toBe(404);
  const db = await flare.getD1Database("DB", "front");
  await db
    .prepare("UPDATE artifact_grants SET status = 'pending' WHERE id = 'g'")
    .run();
  expect((await call("enabled")).status).toBe(404);
  await db
    .prepare("UPDATE artifact_grants SET status = 'approved' WHERE id = 'g'")
    .run();
  expect(
    await db.prepare("SELECT count(*) AS n FROM artifact_views").first()
  ).toEqual(before);
});

test("named main RPC entrypoint refuses HTTP", async () => {
  const bindings = await flare.getBindings("front");
  const main = bindings.MAIN as { fetch: (url: string) => Promise<Response> };
  expect((await main.fetch("https://main.test/host")).status).toBe(404);
});

test("IP and endpoint rate refusals happen before wiring or any D1 read", async () => {
  for (const admitted of [false, true]) {
    const keys: string[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: exercise IP and endpoint refusals independently
    const response = await handleEndpointRoute(
      new Request("https://hooks.test/hooks/id", {
        headers: { "CF-Connecting-IP": "198.51.100.1" },
      }),
      "id",
      {
        limiter: {
          limit: ({ key }) => {
            keys.push(key);
            return Promise.resolve({
              success: admitted && !key.includes("api:endpoint:"),
            });
          },
        },
        wiring: () => {
          throw new Error("Must not read D1");
        },
      }
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(
      admitted
        ? [
            "api:endpoints:ip:198.51.100.0/24",
            "api:endpoint:id:ip:198.51.100.0/24",
          ]
        : [
            "api:endpoints:ip:198.51.100.0/24",
            "api:endpoints:ip:198.51.100.0/24:overflow",
          ]
    );
  }
});
