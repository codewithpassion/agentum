import { describe, expect, test } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { fakePorts } from "./fakes.ts";
import {
  type AppGatewayDeps,
  handleAppRequest,
  MAX_APP_REQUEST_BYTES,
} from "./gateway-core.ts";
import type { AppRuntimeInput } from "./ports.ts";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "hm_view_secret-token-part.signature";
const memberClaims: ViewTokenClaims = {
  artifactId: ARTIFACT,
  expiresAt: 4_000_000_000,
  userId: "alice",
  versionId: "ver-1",
  viewer: "member",
};
const url = (rest: string) =>
  `https://app.test/a/${ARTIFACT}/c/${TOKEN}${rest}`;
const meta = {
  ipPrefix: "1.2.3",
  place: null,
  userAgent: "ua",
  visitorHash: "vh",
};

/** A stand-in for A.4's wrapper: it sets a CSP and a cache header, as the real one does. */
const wrap = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "sandbox allow-scripts allow-forms");
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { headers, status: response.status });
};

const setup = (
  answer: (input: AppRuntimeInput) => Promise<Response> | Response
) => {
  const ports = fakePorts();
  const inputs: AppRuntimeInput[] = [];
  const deps: AppGatewayDeps = {
    applyContentHeaders: wrap,
    ports,
    requestMeta: () => Promise.resolve(meta),
    runtime: {
      handle: async (input) => {
        inputs.push(input);
        return await answer(input);
      },
    },
  };
  const run = (path: string, init?: RequestInit, claims = memberClaims) =>
    handleAppRequest(new Request(url(path), init), claims, deps);
  return { deps, inputs, ports, run };
};

const ok = () => new Response("fine", { status: 200 });

describe("handleAppRequest: routing and claims", () => {
  test("the app sees the path from /api on, the query, and no token", async () => {
    const t = setup(ok);
    await t.run("/api/items/3?x=1", { body: "{}", method: "POST" });
    const seen = t.inputs.at(0)?.request;
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/items/3");
    expect(new URL(seen?.url ?? "").search).toBe("?x=1");
    expect(seen?.url).not.toContain("hm_view");
    expect(seen?.method).toBe("POST");
    expect(await seen?.text()).toBe("{}");
  });

  test("the bare /api path reaches the app too", async () => {
    const t = setup(ok);
    expect((await t.run("/api")).status).toBe(200);
    expect(new URL(t.inputs.at(0)?.request.url ?? "").pathname).toBe("/api");
  });

  test("a path outside /api is 404 and the app is not called", async () => {
    const t = setup(ok);
    expect((await t.run("/apiary")).status).toBe(404);
    expect((await t.run("/index.html")).status).toBe(404);
    expect(t.inputs).toEqual([]);
  });

  test("the host props come from the claims and the ports, not the request", async () => {
    const t = setup(ok);
    await t.run("/api/x", { headers: { "x-viewer": "mallory" } });
    expect(t.inputs.at(0)?.host).toEqual({
      artifactId: ARTIFACT,
      meta,
      versionId: "ver-1",
      viewer: { kind: "member", userId: "alice" },
      workspaceId: "ws-1",
    });
  });

  test("a version that does not belong to the artifact is 404", async () => {
    const t = setup(ok);
    t.ports.source.workspaceOf = () => Promise.resolve(null);
    expect((await t.run("/api/x")).status).toBe(404);
    expect(t.inputs).toEqual([]);
  });

  test("a member token with no user, or a link token with no share, is 401", async () => {
    const t = setup(ok);
    const { userId: _userId, ...noUser } = memberClaims;
    expect((await t.run("/api/x", undefined, noUser)).status).toBe(401);
    expect(
      (await t.run("/api/x", undefined, { ...noUser, viewer: "link" })).status
    ).toBe(401);
  });

  test("a link viewer carries the share's data mode from the port", async () => {
    const t = setup(ok);
    t.ports.share.state = { dataMode: "live", ok: true };
    const { userId: _userId, ...noUser } = memberClaims;
    await t.run("/api/x", undefined, {
      ...noUser,
      shareId: "s1",
      viewer: "link",
    });
    expect(t.inputs.at(0)?.host.viewer).toEqual({
      dataMode: "live",
      kind: "link",
      shareId: "s1",
    });
  });

  test("a revoked link is refused with 403 and the app is not called", async () => {
    const t = setup(ok);
    t.ports.share.state = { ok: false, reason: "revoked" };
    const { userId: _userId, ...noUser } = memberClaims;
    const answer = await t.run("/api/x", undefined, {
      ...noUser,
      shareId: "s1",
      viewer: "link",
    });
    expect(answer.status).toBe(403);
    expect(t.inputs).toEqual([]);
  });

  test("a test token becomes the test viewer", async () => {
    const t = setup(ok);
    await t.run("/api/x", undefined, { ...memberClaims, viewer: "test" });
    expect(t.inputs.at(0)?.host.viewer).toEqual({ kind: "test" });
  });

  test("cookies and authorization do not reach the app", async () => {
    const t = setup(ok);
    await t.run("/api/x", {
      headers: {
        authorization: "Bearer x",
        cookie: "__session=s",
        "x-keep": "1",
      },
    });
    const headers = t.inputs.at(0)?.request.headers;
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("x-keep")).toBe("1");
  });

  test("the visitor's address headers do not reach the app", async () => {
    const t = setup(ok);
    await t.run("/api/x", {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "cf-ipcountry": "AU",
        "true-client-ip": "203.0.113.9",
        "x-forwarded-for": "203.0.113.9",
        "x-keep": "1",
        "x-real-ip": "203.0.113.9",
      },
    });
    const headers = t.inputs.at(0)?.request.headers;
    expect(headers?.get("x-keep")).toBe("1");
    for (const name of [
      "cf-connecting-ip",
      "cf-ipcountry",
      "true-client-ip",
      "x-forwarded-for",
      "x-real-ip",
    ]) {
      expect(headers?.has(name)).toBe(false);
    }
  });

  test("a failing port answers 502 through the content headers", async () => {
    const t = setup(ok);
    t.ports.source.workspaceOf = () => Promise.reject(new Error("D1 is down"));
    const answer = await t.run("/api/x");
    expect(answer.status).toBe(502);
    expect(answer.headers.get("content-security-policy")).toContain("sandbox");
    expect(await answer.text()).not.toContain("D1");
  });

  test("a body over the cap is 413 and the app is not called", async () => {
    const t = setup(ok);
    const answer = await t.run("/api/x", {
      body: new Uint8Array(MAX_APP_REQUEST_BYTES + 1),
      method: "POST",
    });
    expect(answer.status).toBe(413);
    expect(t.inputs).toEqual([]);
  });
});

describe("handleAppRequest: CORS", () => {
  test("a preflight answers 204 with a wildcard origin, no credentials, and no app call", async () => {
    const t = setup(ok);
    const answer = await t.run("/api/items", {
      headers: {
        "Access-Control-Request-Headers": "content-type, x-thing",
        "Access-Control-Request-Method": "POST",
      },
      method: "OPTIONS",
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("access-control-allow-credentials")).toBeNull();
    expect(answer.headers.get("access-control-allow-methods")).toContain(
      "POST"
    );
    expect(answer.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-thing"
    );
    expect(t.inputs).toEqual([]);
    expect(answer.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("handleAppRequest: header rules", () => {
  const evil = () =>
    new Response("{}", {
      headers: [
        ["Content-Type", "application/json"],
        ["Set-Cookie", "__session=evil; Domain=rockyshoreslabs.io; Path=/"],
        ["Clear-Site-Data", '"cookies"'],
        ["Service-Worker-Allowed", "/"],
        ["Access-Control-Allow-Origin", "https://evil.test"],
        ["Access-Control-Allow-Credentials", "true"],
        ["Cache-Control", "public, max-age=99999"],
        ["Content-Security-Policy", "default-src *"],
        ["Location", "https://evil.test/"],
        ["ETag", '"v1"'],
        ["Vary", "Accept"],
      ],
    });

  test("only allowlisted headers survive, and the content headers win", async () => {
    const t = setup(evil);
    const answer = await t.run("/api/x");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("clear-site-data")).toBeNull();
    expect(answer.headers.get("service-worker-allowed")).toBeNull();
    expect(answer.headers.get("access-control-allow-credentials")).toBeNull();
    expect(answer.headers.get("location")).toBeNull();
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms"
    );
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(answer.headers.get("etag")).toBe('"v1"');
    expect(answer.headers.get("vary")).toBe("Accept");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("every status has the content headers: 204, 404 from the app, 502, 504, 413 and the gateway's own 404", async () => {
    const cases: [string, () => Promise<Response> | Response][] = [
      ["204", () => new Response(null, { status: 204 })],
      ["404", () => new Response("no", { status: 404 })],
      ["502", () => Promise.reject(new Error("boom"))],
    ];
    const responses = await Promise.all(
      cases.map(([, answer]) => setup(answer).run("/api/x"))
    );
    responses.forEach((response, index) => {
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox"
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(String(response.status)).toBe(cases[index]?.[0] ?? "");
    });
    const timeout = setup(() => new Promise<Response>(() => undefined));
    timeout.deps.wallMs = 10;
    const slow = await handleAppRequest(
      new Request(url("/api/x")),
      memberClaims,
      timeout.deps
    );
    expect(slow.status).toBe(504);
    expect(slow.headers.get("content-security-policy")).toContain("sandbox");
    const outside = await setup(ok).run("/nope");
    expect(outside.status).toBe(404);
    expect(outside.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("a rejection answers 502 with a fixed body that leaves out the app's message", async () => {
    const t = setup(() =>
      Promise.reject(new Error("secret internal stack trace"))
    );
    const answer = await t.run("/api/x");
    expect(answer.status).toBe(502);
    expect(await answer.text()).not.toContain("secret internal");
  });

  test("an app redirect loses its Location", async () => {
    const t = setup(() => Response.redirect("https://evil.test/", 302));
    const answer = await t.run("/api/x");
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBeNull();
  });
});
