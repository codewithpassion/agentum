import { beforeEach, describe, expect, it } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
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
let limitKeys: string[];
let owner: User;
let artifactId: string;
let versionId: string;
let linksOff: boolean;

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

/** Calls the app with a fake `SHARE_OPEN_LIMIT` binding. */
const request = (path: string, init: RequestInit = {}) =>
  app.request(path, init, {
    SHARE_OPEN_LIMIT: limit ? { limit } : undefined,
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
  limitKeys = [];
  const db = migrated();
  composed = composeWith({
    allowedOrgIds: ["org_a", "org_b"],
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
    expect(body.contentUrl).toContain(`/a/${artifactId}/c/hm_view_`);
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
      allowedOrgIds: ["org_a"],
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
