import { describe, expect, test } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { signViewToken } from "@repo/services/artifacts/view-token";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { fakePorts } from "./fakes.ts";
import { type AppGatewayWiring, mountAppGatewayRoutes } from "./mount.ts";
import type { AppRuntimeInput } from "./ports.ts";

const ORIGIN = "https://hm.test";
const KEY = "test-view-key";
const ARTIFACT = "6f1c2f0e-8f0e-4c3a-9f37-2b3f3c1d9a10";
const OTHER = "0b9f6a7e-3c1d-4d7e-8a55-6a1d9d5b7c22";
const NOW = 1_800_000_000;

const claims = (over: Partial<ViewTokenClaims> = {}): ViewTokenClaims => ({
  artifactId: ARTIFACT,
  expiresAt: NOW + 600,
  userId: "alice",
  versionId: "ver_1",
  viewer: "member",
  workspaceId: "ws_1",
  ...over,
});

const setup = (declaresHosts = false, allow = true) => {
  const ports = fakePorts();
  const inputs: AppRuntimeInput[] = [];
  const wiring: AppGatewayWiring = {
    declaresHosts: () => Promise.resolve(declaresHosts),
    ports,
    requestMeta: () =>
      Promise.resolve({
        ipPrefix: null,
        place: null,
        userAgent: null,
        visitorHash: "vh",
      }),
    runtime: {
      handle: (input) => {
        inputs.push(input);
        return Promise.resolve(new Response("from the app"));
      },
    },
  };
  const app = new Hono<AppEnv>();
  const limited: string[] = [];
  mountAppGatewayRoutes(app, {
    limiter: () => ({
      limit: ({ key }) => {
        limited.push(key);
        return Promise.resolve({ success: allow });
      },
    }),
    nowSeconds: () => NOW,
    viewKey: () => KEY,
    wiring: () => wiring,
  });
  const call = async (
    over: Partial<ViewTokenClaims>,
    init: RequestInit = {},
    pathArtifact = ARTIFACT,
    rest = "/api/items"
  ) => {
    const token = await signViewToken(claims(over), KEY);
    return app.request(
      `${ORIGIN}/a/${pathArtifact}/c/${encodeURIComponent(token)}${rest}`,
      init,
      {} as Env
    );
  };
  return { app, call, inputs, limited, ports };
};

describe("app gateway route", () => {
  test("a good token reaches the app, with the content headers", async () => {
    const t = setup();
    const response = await t.call({}, { body: "{}", method: "POST" });
    expect(await response.text()).toBe("from the app");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox"
    );
    expect(t.inputs).toHaveLength(1);
  });

  test("a token for another artifact is 401 and never reaches the app", async () => {
    const t = setup();
    const response = await t.call({}, {}, OTHER);
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox"
    );
    expect(t.inputs).toHaveLength(0);
  });

  test("a token signed with another key is 401", async () => {
    const t = setup();
    const token = await signViewToken(claims(), "other-key");
    const response = await t.app.request(
      `${ORIGIN}/a/${ARTIFACT}/c/${encodeURIComponent(token)}/api/items`,
      {},
      {} as Env
    );
    expect(response.status).toBe(401);
    expect(t.inputs).toHaveLength(0);
  });

  test("a snapshot link on a version that declares hosts is 403", async () => {
    const t = setup(true);
    t.ports.share.state = { dataMode: "snapshot", ok: true };
    const response = await t.call({
      shareId: "s1",
      userId: undefined,
      viewer: "link",
    });
    expect(response.status).toBe(403);
    expect(t.inputs).toHaveLength(0);
  });

  test("a test viewer on a version that declares hosts is 403", async () => {
    const t = setup(true);
    expect((await t.call({ viewer: "test" })).status).toBe(403);
  });

  test("a snapshot link on a version without hosts still reaches the app", async () => {
    const t = setup(false);
    t.ports.share.state = { dataMode: "snapshot", ok: true };
    const response = await t.call({
      shareId: "s1",
      userId: undefined,
      viewer: "link",
    });
    expect(response.status).toBe(200);
  });

  test("a live link on a version that declares hosts reaches the app", async () => {
    const t = setup(true);
    t.ports.share.state = { dataMode: "live", ok: true };
    const response = await t.call({
      shareId: "s1",
      userId: undefined,
      viewer: "link",
    });
    expect(response.status).toBe(200);
  });

  test("a preflight with a good token is answered", async () => {
    const t = setup();
    const response = await t.call({}, { method: "OPTIONS" });
    expect(response.status).toBeLessThan(300);
    expect(t.inputs).toHaveLength(0);
  });
});

describe("app gateway route: flood guard and headers", () => {
  const link = { shareId: "s1", userId: undefined, viewer: "link" } as const;

  test("a link holder over the limit gets 429 and the app is not reached", async () => {
    const t = setup(false, false);
    t.ports.share.state = { dataMode: "live", ok: true };
    const response = await t.call(link);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox"
    );
    expect(t.inputs).toHaveLength(0);
    expect(t.limited[0]).toBe("api:link:s1");
  });

  test("a link holder inside the limit is counted per link", async () => {
    const t = setup();
    t.ports.share.state = { dataMode: "live", ok: true };
    expect((await t.call(link)).status).toBe(200);
    expect(t.limited).toEqual(["api:link:s1"]);
  });

  test("a member is not counted", async () => {
    const t = setup(false, false);
    expect((await t.call({})).status).toBe(200);
    expect(t.limited).toEqual([]);
  });

  test("every refusal the route makes carries the CSP and no-store", async () => {
    const t = setup(true);
    const refused = [
      await t.call({ viewer: "test" }),
      await t.call({}, {}, OTHER),
      await t.call({}, { method: "OPTIONS" }),
    ];
    for (const response of refused) {
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "sandbox"
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });
});
