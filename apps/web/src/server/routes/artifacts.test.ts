import { beforeEach, describe, expect, it } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { artifactGrants, artifactViews } from "@repo/db/schema/artifacts";
import { migrated } from "@repo/db/test-db";
import { ArtifactCallError } from "@repo/services/artifacts/calls";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { artifactRoutes } from "./artifacts.ts";
import type { AppEnv } from "./groups.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ORIGIN = "https://hm.test";
const UNAVAILABLE = { error: "This link is not available." };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface Session {
  orgId: string | null;
  userId: string | null;
}
const OWNER: Session = { orgId: "org_a", userId: "user_a" };

type User = Extract<Principal, { kind: "user" }>;
type Limit = (options: { key: string }) => Promise<{ success: boolean }>;

let composed: Composed;
let session: Session | null;
let limit: Limit | null;
let openLimit: { limit: Limit } | null;
let limitKeys: string[];
let owner: User;
let artifactId: string;
let versionId: string;
let linksOff: boolean;
let testDb: ReturnType<typeof migrated>;
let toolRuns: unknown[];
let toolError: Error | null;
let storeData: Map<string, string>;
const TOOL = "xero/list_invoices";

const infra = (db: ReturnType<typeof migrated>): Infra => {
  const store = new Map<string, string>();
  return {
    artifactLinksOff: linksOff,
    artifactViewKey: "view-key",
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: false,
    appStore: {
      delete: async () => undefined,
      get: (_scope, key) => Promise.resolve(storeData.get(key) ?? null),
      list: (_scope, prefix) =>
        Promise.resolve(
          [...storeData]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }))
        ),
      set: async () => undefined,
    },
    isOrgMember: () => Promise.resolve(true),
    toolRunner: {
      run: (input) => {
        toolRuns.push(input);
        return toolError
          ? Promise.reject(toolError)
          : Promise.resolve({ result: { total: 42 } });
      },
    },
    fileBlobs: {
      delete: async () => undefined,
      get: async () => null,
      put: async () => undefined,
    } as never,
    publicBaseUrl: ORIGIN,
    relay: noopRelay,
    runTokenKey: KEY,
    secretsKey: KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/", artifactRoutes({ session: () => session }));

/**
 * Calls the app with fake `SHARE_OPEN_LIMIT` and `SHARE_CALL_LIMIT` bindings:
 * both run `limit`, and `openLimit`, when set, replaces the open one.
 */
const request = (path: string, init: RequestInit = {}) =>
  app.request(path, init, {
    SHARE_CALL_LIMIT: limit ? { limit } : undefined,
    SHARE_OPEN_LIMIT: openLimit ?? (limit ? { limit } : undefined),
  } as never);

const open = (token: string, headers: Record<string, string> = {}) =>
  request(`/api/share/${token}/open`, { headers, method: "POST" });

const newLink = async (options: { expiresAt?: string } = {}) => {
  const share = await composed.services.artifactShares.createShare(owner, {
    artifactId,
    dataMode: "snapshot",
    ...options,
  });
  return { id: share.id, token: share.url.slice(`${ORIGIN}/s/`.length) };
};

beforeEach(async () => {
  linksOff = false;
  session = OWNER;
  limit = null;
  openLimit = null;
  limitKeys = [];
  toolRuns = [];
  toolError = null;
  storeData = new Map([["stats", '{"total":3}']]);
  const db = migrated(["org_a", "org_b"]);
  testDb = db;
  composed = composeWith({
    db,
    infra: infra(db),
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a must be allowed");
  }
  owner = {
    isAdmin: true,
    kind: "user",
    userId: "user_a",
    via: "session",
    workspaceId: workspace.id,
  };
  const created = await composed.services.artifacts.create(owner, {
    files: [
      { path: "index.html", text: "<h1>hi</h1>" },
      { path: "data.json", text: "{}" },
    ],
    kind: "page",
    title: "Report",
  });
  ({ artifactId, versionId } = created);
});

describe("POST /api/share/:token/open", () => {
  it("opens a live link without a session and sends no store header", async () => {
    session = null;
    const { token } = await newLink();
    const res = await open(token, { "CF-Connecting-IP": "203.0.113.9" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { contentUrl: string; title: string };
    expect(body.title).toBe("Report");
    expect(body.contentUrl).toContain(`/a/${artifactId}/c/ag_view_`);
  });

  it("R1.29 answers revoked, expired, unknown and malformed links with one body", async () => {
    const revoked = await newLink();
    await composed.services.artifactShares.revokeShare(owner, {
      shareId: revoked.id,
    });
    const expired = await newLink({
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const responses = await Promise.all(
      [revoked.token, expired.token, "hm_share_unknown", "junk"].map((t) =>
        open(t)
      )
    );
    expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    for (const body of bodies) {
      expect(body).toEqual(UNAVAILABLE);
    }
  });

  it("R1.29 answers 404 once the workspace switch is off", async () => {
    const { token } = await newLink();
    await composed.services.artifactShares.setLinksEnabled(owner, {
      enabled: false,
    });
    const res = await open(token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  it("R1.36 refuses every link while ARTIFACT_LINKS_OFF is set", async () => {
    const { token } = await newLink();
    expect((await open(token)).status).toBe(200);
    // The same database, now on a Worker with the variable set.
    linksOff = true;
    composed = composeWith({
      db: composed.db,
      infra: infra(composed.db as ReturnType<typeof migrated>),
    });
    const res = await open(token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  it("R1.35 limits per token and per IP prefix and answers 429", async () => {
    const counts = new Map<string, number>();
    limit = ({ key }) => {
      limitKeys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve({ success: next <= 2 });
    };
    const { token } = await newLink();
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    const first = await open(token, ip);
    const second = await open(token, ip);
    const third = await open(token, ip);
    expect([first.status, second.status, third.status]).toEqual([
      200, 200, 429,
    ]);
    expect(third.headers.get("Retry-After")).toBe("60");
    // Another token from the same /24 shares the IP budget.
    const other = await open("hm_share_other", {
      "CF-Connecting-IP": "203.0.113.77",
    });
    expect(other.status).toBe(429);
    // The limiter sees a hash of the token and the prefix, never the full IP or the token.
    expect(limitKeys.some((key) => key === "ip:203.0.113.0/24")).toBe(true);
    expect(limitKeys.some((key) => key.startsWith("token:"))).toBe(true);
    expect(limitKeys.join(" ")).not.toContain(token);
    expect(limitKeys.join(" ")).not.toContain("203.0.113.9");
  });
});

describe("GET /api/artifacts/:id/thumbnail", () => {
  it("needs a session", async () => {
    session = null;
    const res = await request(`/api/artifacts/${artifactId}/thumbnail`);
    expect(res.status).toBe(401);
  });

  it("is 404 before a test sets one and for an unknown artifact", async () => {
    const before = await request(`/api/artifacts/${artifactId}/thumbnail`);
    expect(before.status).toBe(404);
    const unknown = await request(
      "/api/artifacts/00000000-0000-4000-8000-000000000000/thumbnail"
    );
    expect(unknown.status).toBe(404);
  });

  it("serves the PNG with the file headers once set", async () => {
    await composed.services.artifacts.setAudience(
      owner,
      artifactId,
      "workspace"
    );
    await composed.services.artifacts.setThumbnail(
      {
        agentId: "agent_x",
        kind: "run",
        runId: "run_x",
        workspaceId: owner.workspaceId,
      },
      { artifactId, png: PNG, versionId }
    );
    const res = await request(
      `/api/artifacts/${artifactId}/thumbnail?version=1`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("refuses a malformed version", async () => {
    const res = await request(
      `/api/artifacts/${artifactId}/thumbnail?version=abc`
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/artifacts/:id/download", () => {
  it("sends the version's files as a zip attachment", async () => {
    const res = await request(
      `/api/artifacts/${artifactId}/download?version=1`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    // The zip's headers hold the plain file names; its contents are covered in the service tests.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("index.html");
    expect(text).toContain("data.json");
  });

  it("hides the artifact from another workspace", async () => {
    // Make the other workspace exist, then ask as one of its members.
    await composed.services.workspaces.forOrg({ clerkOrgId: "org_b" });
    session = { orgId: "org_b", userId: "user_b" };
    const [download, thumbnail] = await Promise.all([
      request(`/api/artifacts/${artifactId}/download`),
      request(`/api/artifacts/${artifactId}/thumbnail`),
    ]);
    expect([download.status, thumbnail.status]).toEqual([404, 404]);
  });

  it("needs a session", async () => {
    session = { orgId: null, userId: "user_a" };
    expect(
      (await request(`/api/artifacts/${artifactId}/download`)).status
    ).toBe(401);
  });
});

const newLiveLink = async () => {
  testDb
    .insert(artifactGrants)
    .values({
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      kind: "tool",
      status: "approved",
      target: TOOL,
      versionId,
      workspaceId: owner.workspaceId,
    })
    .run();
  const share = await composed.services.artifactShares.createShare(owner, {
    artifactId,
    dataMode: "live",
    liveTools: [TOOL],
  });
  return { id: share.id, token: share.url.slice(`${ORIGIN}/s/`.length) };
};

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  request(path, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });

/** A flood guard that refuses every call, but still lets the refusal be logged. */
const refuseCalls: Limit = ({ key }) =>
  Promise.resolve({ success: key.startsWith("calllog:") });

const ipHeader = (index: number) => ({
  "CF-Connecting-IP": `198.51.${index}.7`,
});

const viewsOf = (shareId: string) =>
  testDb
    .select()
    .from(artifactViews)
    .all()
    .filter((row) => row.shareId === shareId && row.surface === "live_call");

const call = (token: string, body: unknown, headers = {}) =>
  post(`/api/share/${token}/call`, body, headers);

describe("POST /api/share/:token/call", () => {
  it("runs a live link's tool without a session and answers { result }", async () => {
    session = null;
    const { token } = await newLiveLink();
    const res = await call(
      token,
      { arguments: { month: "2026-09" }, tool: TOOL },
      { "CF-Connecting-IP": "203.0.113.9" }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ result: { total: 42 } });
    expect(toolRuns).toEqual([
      {
        agentId: null,
        arguments: { month: "2026-09" },
        toolKey: TOOL,
        userId: "user_a",
        workspaceId: owner.workspaceId,
      },
    ]);
  });

  it("answers 403 for a snapshot link and for a tool outside the link, and runs nothing", async () => {
    const snapshot = await newLink();
    const live = await newLiveLink();
    const [one, two] = await Promise.all([
      call(snapshot.token, { tool: TOOL }),
      call(live.token, { tool: "xero/get_invoice" }),
    ]);
    expect([one.status, two.status]).toEqual([403, 403]);
    expect(toolRuns).toHaveLength(0);
  });

  it("answers 404 with one body for revoked, unknown and malformed links", async () => {
    const live = await newLiveLink();
    await composed.services.artifactShares.revokeShare(owner, {
      shareId: live.id,
    });
    const responses = await Promise.all(
      [live.token, "hm_share_unknown", "junk"].map((t) =>
        call(t, { tool: TOOL })
      )
    );
    expect(responses.map((res) => res.status)).toEqual([404, 404, 404]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies).toEqual(responses.map(() => UNAVAILABLE));
    expect(toolRuns).toHaveLength(0);
  });

  it("answers 400 for a body that is not a call", async () => {
    const { token } = await newLiveLink();
    const bodies = ["not json", {}, { tool: "" }, { tool: TOOL, extra: 1 }];
    const responses = await Promise.all(
      bodies.map((body) => call(token, body))
    );
    expect(responses.map((res) => res.status)).toEqual([400, 400, 400, 400]);
  });

  it("answers 429 from the flood guard under its own keys", async () => {
    limit = ({ key }) => {
      limitKeys.push(key);
      return Promise.resolve({ success: false });
    };
    const { token } = await newLiveLink();
    const res = await call(
      token,
      { tool: TOOL },
      {
        "CF-Connecting-IP": "203.0.113.9",
      }
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(limitKeys).toContain("call:ip:203.0.113.0/24");
    expect(
      limitKeys.every(
        (key) => key.startsWith("call:") || key.startsWith("calllog:")
      )
    ).toBe(true);
    expect(limitKeys.join(" ")).not.toContain(token);
    expect(toolRuns).toHaveLength(0);
  });

  it("uses its own flood guard, which the open guard does not touch", async () => {
    openLimit = { limit: () => Promise.resolve({ success: false }) };
    const { token } = await newLiveLink();
    expect((await call(token, { tool: TOOL })).status).toBe(200);
  });

  it("lets the service's 60 a minute per link decide, not the flood guard", async () => {
    // The guard allows 120 a minute per key, as wrangler.jsonc sets it.
    const counts = new Map<string, number>();
    let refusedByGuard = 0;
    limit = ({ key }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      const success = used <= 120;
      refusedByGuard += success ? 0 : 1;
      return Promise.resolve({ success });
    };
    const live = await newLiveLink();
    const statuses: number[] = [];
    for (let index = 0; index < 62; index += 1) {
      // Each call is a different visitor, so the 10 a minute per visitor never applies.
      statuses.push(
        // biome-ignore lint/performance/noAwaitInLoops: the calls must land in order
        (await call(live.token, { tool: TOOL }, ipHeader(index))).status
      );
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    expect(refusedByGuard).toBe(0);
    expect(
      viewsOf(live.id)
        .map((row) => row.outcome)
        .slice(60)
    ).toEqual(["rate_limited", "rate_limited"]);
  });

  it("R2.14 writes a rate_limited row for a call the flood guard refuses", async () => {
    const live = await newLiveLink();
    limit = refuseCalls;
    const res = await call(live.token, { tool: TOOL }, ipHeader(1));
    expect(res.status).toBe(429);
    expect(viewsOf(live.id)).toMatchObject([
      { outcome: "rate_limited", surface: "live_call", toolKey: null },
    ]);
    expect(toolRuns).toHaveLength(0);
  });

  it("R2.14 caps the rows a flood of guard refusals can write", async () => {
    const live = await newLiveLink();
    let logged = 0;
    limit = ({ key }) => {
      if (key.startsWith("calllog:")) {
        logged += 1;
        return Promise.resolve({ success: logged <= 2 });
      }
      return Promise.resolve({ success: false });
    };
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push(
        // biome-ignore lint/performance/noAwaitInLoops: the calls must land in order
        (await call(live.token, { tool: TOOL }, ipHeader(1))).status
      );
    }
    expect(statuses).toEqual([429, 429, 429, 429, 429]);
    expect(viewsOf(live.id)).toHaveLength(1);
  });

  it("R2.14 keeps a dead link's own outcome when the guard refuses", async () => {
    const live = await newLiveLink();
    await composed.services.artifactShares.revokeShare(owner, {
      shareId: live.id,
    });
    limit = refuseCalls;
    expect((await call(live.token, { tool: TOOL })).status).toBe(429);
    expect(viewsOf(live.id).map((row) => row.outcome)).toEqual(["revoked"]);
  });

  it("R2.14 writes a refused row for a body that is not a call", async () => {
    const live = await newLiveLink();
    expect((await call(live.token, { tool: "" })).status).toBe(400);
    expect(viewsOf(live.id)).toMatchObject([
      { outcome: "refused", surface: "live_call", toolKey: null },
    ]);
  });

  it("R2.14 writes nothing for an unknown token, and answers as before", async () => {
    expect((await call("hm_share_unknown", { tool: "" })).status).toBe(400);
    expect((await call("hm_share_unknown", { tool: TOOL })).status).toBe(404);
    limit = refuseCalls;
    expect((await call("hm_share_unknown", { tool: TOOL })).status).toBe(429);
    expect(testDb.select().from(artifactViews).all()).toHaveLength(0);
  });

  it("answers 429 above 10 calls a minute from one visitor", async () => {
    const { token } = await newLiveLink();
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the calls must land in order
      statuses.push((await call(token, { tool: TOOL }, ip)).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(toolRuns).toHaveLength(10);
  });

  it("answers 502 without detail when the tool fails", async () => {
    toolError = new ArtifactCallError("needs_auth", "Connect Xero for dom");
    const original = console.error;
    console.error = () => undefined;
    const { token } = await newLiveLink();
    const res = await call(token, { tool: TOOL });
    console.error = original;
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("Xero");
  });
});

describe("POST /api/share/:token/storage", () => {
  const storage = (token: string, body: unknown, headers = {}) =>
    post(`/api/share/${token}/storage`, body, headers);

  it("reads the shared area for a link viewer without a session", async () => {
    session = null;
    const { token } = await newLink();
    const got = await storage(token, { key: "stats", op: "get" });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ result: { value: { total: 3 } } });
    const listed = await storage(token, { op: "list", prefix: "st" });
    expect(await listed.json()).toEqual({ result: { keys: ["stats"] } });
  });

  it("answers 403 to every write", async () => {
    const { token } = await newLiveLink();
    const responses = await Promise.all(
      ["set", "delete"].map((op) =>
        storage(token, { key: "stats", op, value: 1 })
      )
    );
    expect(responses.map((res) => res.status)).toEqual([403, 403]);
  });

  it("answers 404 with one body for dead links, writes included", async () => {
    const live = await newLiveLink();
    await composed.services.artifactShares.revokeShare(owner, {
      shareId: live.id,
    });
    const responses = await Promise.all([
      storage(live.token, { op: "list" }),
      storage(live.token, { key: "stats", op: "set" }),
      storage("hm_share_unknown", { op: "list" }),
    ]);
    expect(responses.map((res) => res.status)).toEqual([404, 404, 404]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies).toEqual(responses.map(() => UNAVAILABLE));
  });

  it("answers 400 for a bad body and 429 from the flood guard", async () => {
    const { token } = await newLink();
    expect((await storage(token, { op: "get" })).status).toBe(400);
    expect((await storage(token, "nope")).status).toBe(400);
    limit = ({ key }) => {
      limitKeys.push(key);
      return Promise.resolve({ success: false });
    };
    const res = await storage(token, { op: "list" });
    expect(res.status).toBe(429);
    expect(limitKeys.every((key) => key.startsWith("storage:"))).toBe(true);
  });
});
