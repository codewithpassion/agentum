/**
 * Runs the gateway in a real workerd (Miniflare) with a real Worker Loader:
 * a sample `server/index.js` is loaded as a Dynamic Worker and calls `AgentumHost`
 * over RPC. The same behaviour `docs/v3/phase2-spike.md` measured under
 * `wrangler dev`, now through the code that ships.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "bun";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const TRAILING_SLASH = /\/$/;
const TOKEN = "hm_view_t.s";

interface MiniflareHandle {
  dispose: () => Promise<void>;
  ready: Promise<URL>;
}

let flare: MiniflareHandle;
let base = "";

const resolveMiniflare = async () => {
  // miniflare is wrangler's dependency, not ours.
  const fromApp = createRequire(import.meta.url);
  const wranglerDir = fromApp.resolve("wrangler/package.json");
  const path = createRequire(wranglerDir).resolve("miniflare");
  return (await import(path)) as {
    Miniflare: new (options: unknown) => MiniflareHandle;
    convertV4MiniflareOptions: (options: unknown) => unknown;
  };
};

beforeAll(async () => {
  const built = await build({
    entrypoints: [
      fileURLToPath(new URL("./real-worker-fixture.ts", import.meta.url)),
    ],
    external: ["cloudflare:workers"],
    format: "esm",
    target: "node",
  });
  if (!built.success) {
    throw new Error(built.logs.map(String).join("\n"));
  }
  const script = await built.outputs[0]?.text();
  const { Miniflare, convertV4MiniflareOptions } = await resolveMiniflare();
  flare = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: "2026-08-19",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      name: "app-gateway-test",
      script,
      workerLoaders: { LOADER: {} },
    })
  );
  base = String(await flare.ready).replace(TRAILING_SLASH, "");
}, 60_000);

afterAll(async () => {
  await flare?.dispose();
});

const send = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { body: JSON.stringify(body), method: "POST" });

const seed = (
  versionId: string,
  server: string,
  hosts?: string[],
  declaresHosts = false
) =>
  send("/__seed", {
    declaresHosts,
    files: [{ path: "server/index.js", text: server }],
    hosts,
    versionId,
  });

const member = (userId: string, versionId: string) => ({
  artifactId: ARTIFACT,
  expiresAt: 4_000_000_000,
  userId,
  versionId,
  viewer: "member",
  workspaceId: "ws-1",
});

interface Answer {
  error?: string;
  hasCookie?: boolean;
  hits?: number;
  ok?: unknown;
  shared?: unknown;
  url?: string;
  viewer?: unknown;
  who?: unknown;
}

const call = (claims: unknown, path: string, init: RequestInit = {}) =>
  fetch(`${base}/a/${ARTIFACT}/c/${TOKEN}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      "x-test-claims": JSON.stringify(claims),
    },
  });

const callJson = async (...args: Parameters<typeof call>): Promise<Answer> =>
  (await call(...args)).json() as Promise<Answer>;

const APP = `
let hits = 0;
const attempt = async (run) => { try { return { ok: await run() }; } catch (e) { return { error: String(e && e.message || e) }; } };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    hits += 1;
    switch (url.pathname) {
      case "/api/who": return Response.json({ hits, who: await env.AGENTUM.whoami(), url: request.url, hasCookie: request.headers.has("cookie") });
      case "/api/put": await env.AGENTUM.setItem("viewer", "k", await request.text()); return new Response("stored");
      case "/api/shared": return Response.json(await attempt(() => env.AGENTUM.setItem("shared", "k", "s")));
      case "/api/get": return Response.json({ viewer: await env.AGENTUM.getItem("viewer", "k"), shared: await env.AGENTUM.getItem("shared", "k") });
      case "/api/fetch": return Response.json(await attempt(async () => (await fetch(url.searchParams.get("u"))).status));
      case "/api/headers": return new Response("{}", { headers: [["Set-Cookie", "__session=evil; Path=/"], ["Clear-Site-Data", "\\"cookies\\""], ["Access-Control-Allow-Origin", "https://evil.test"], ["Content-Type", "application/json"]] });
      case "/api/throw": throw new Error("kaboom internal");
      default: return new Response("not here", { status: 404 });
    }
  },
};`;

describe("the gateway in workerd with a real Worker Loader", () => {
  test("two viewers on one cached Worker each get their own AgentumHost", async () => {
    await seed("v-who", APP);
    const alice = await callJson(member("alice", "v-who"), "/api/who");
    const bob = await callJson(member("bob", "v-who"), "/api/who");
    expect(alice.who).toEqual({ dataMode: null, viewer: "member" });
    // One Worker for the version: module state carries over between viewers.
    expect([alice.hits, bob.hits]).toEqual([1, 2]);
    // The app sees the path without the token and without cookies.
    expect(new URL(alice.url ?? "").pathname).toBe("/api/who");
    expect(alice.url).not.toContain("hm_view");
    expect(alice.hasCookie).toBe(false);
  });

  test("storage goes through AgentumHost: a viewer area per person and one shared area", async () => {
    await seed("v-store", APP);
    const put = await call(member("alice", "v-store"), "/api/put", {
      body: "alice-note",
      method: "POST",
    });
    expect(await put.text()).toBe("stored");
    expect(await callJson(member("alice", "v-store"), "/api/get")).toEqual({
      shared: null,
      viewer: "alice-note",
    });
    expect(await callJson(member("bob", "v-store"), "/api/get")).toEqual({
      shared: null,
      viewer: null,
    });
    expect(await callJson(member("bob", "v-store"), "/api/shared")).toEqual({});
    expect(
      (await callJson(member("alice", "v-store"), "/api/get")).shared
    ).toBe("s");
  });

  test("a snapshot link reads but cannot write, and a revoked link is refused", async () => {
    await seed("v-link", APP);
    await send("/__share", { dataMode: "snapshot", ok: true });
    const link = {
      ...member("x", "v-link"),
      shareId: "s1",
      userId: undefined,
      viewer: "link",
    };
    const who = await callJson(link, "/api/who");
    expect(who.who).toEqual({ dataMode: "snapshot", viewer: "link" });
    const write = await callJson(link, "/api/shared");
    expect(write.error).toStartWith("forbidden:");
    await send("/__share", { ok: false, reason: "revoked" });
    expect((await call(link, "/api/who")).status).toBe(403);
  });

  test("a version that declares no host has no network at all", async () => {
    await seed("v-null", APP);
    const answer = await callJson(
      member("alice", "v-null"),
      "/api/fetch?u=https://example.com/"
    );
    expect(answer.error).toContain("not permitted");
  });

  test("a version with hosts reaches an approved host and gets 403 from the filter for any other", async () => {
    await seed("v-hosts", APP, ["approved.invalid"], true);
    const blocked = await callJson(
      member("alice", "v-hosts"),
      "/api/fetch?u=https://blocked.test/"
    );
    expect(blocked.ok).toBe(403);
    const approved = await callJson(
      member("alice", "v-hosts"),
      "/api/fetch?u=https://approved.invalid/"
    );
    // The filter let it through: the request left for a host that does not resolve.
    expect(approved.ok).not.toBe(403);
    // Approvals are read per request, so removing the host closes it without a new Worker.
    await send("/__hosts", []);
    const closed = await callJson(
      member("alice", "v-hosts"),
      "/api/fetch?u=https://approved.invalid/"
    );
    expect(closed.ok).toBe(403);
  });

  test("app headers are filtered and the content headers are set", async () => {
    await seed("v-headers", APP);
    const answer = await call(member("alice", "v-headers"), "/api/headers");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("clear-site-data")).toBeNull();
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("content-security-policy")).toContain("sandbox");
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
  });

  test("a throwing app, a bad bundle and a missing version answer with fixed bodies", async () => {
    await seed("v-throw", APP);
    const thrown = await call(member("alice", "v-throw"), "/api/throw");
    expect(thrown.status).toBe(502);
    expect(await thrown.text()).not.toContain("kaboom");
    await seed("v-bad", "export default { fetch( {");
    const bad = await call(member("alice", "v-bad"), "/api/who");
    expect(bad.status).toBe(502);
    expect(await bad.text()).not.toContain("Syntax");
    const missing = await call(member("alice", "v-none"), "/api/who");
    expect(missing.status).toBe(502);
  });

  test("a preflight answers without loading the app", async () => {
    const answer = await call(member("alice", "v-never"), "/api/who", {
      method: "OPTIONS",
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

test("reply RPC uses a reply viewer and writes shared storage in the real loader", async () => {
  await seed(
    "v-reply",
    `export default {
    fetch() { return new Response("ok"); },
    async reply(message, env) {
      await env.AGENTUM.setItem("shared", "reply-result", JSON.stringify({ message, who: await env.AGENTUM.whoami() }));
    }
  };`
  );
  const response = await send("/__reply", {
    message: {
      fileIds: [],
      runId: "run-1",
      state: "opaque",
      status: "finished",
      text: "done",
    },
    versionId: "v-reply",
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toEqual({
    message: {
      fileIds: [],
      runId: "run-1",
      state: "opaque",
      status: "finished",
      text: "done",
    },
    who: { dataMode: null, viewer: "reply" },
  });
});

test("a real loader skips a missing reply export and reports a thrown reply", async () => {
  await seed(
    "v-no-reply",
    `export default { fetch() { return new Response("ok"); } };`
  );
  const message = {
    fileIds: [],
    runId: "r",
    state: "",
    status: "failed",
    text: "",
  };
  expect(
    (await send("/__reply", { message, versionId: "v-no-reply" })).status
  ).toBe(200);
  await seed(
    "v-bad-reply",
    `export default { fetch() { return new Response("ok"); }, reply() { throw new Error("reply failed"); } };`
  );
  expect(
    (await send("/__reply", { message, versionId: "v-bad-reply" })).status
  ).toBe(500);
});
