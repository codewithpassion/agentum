import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountArtifactContentRoutes } from "./artifact-content/routes.ts";
import { frameGuard } from "./frame-guard.ts";
import type { AppEnv } from "./routes/groups.ts";

const app = new Hono();
app.use("*", frameGuard);
app.get("/page", (c) => c.text("page"));
app.get("/files/x", (c) => {
  c.header("Content-Security-Policy", "sandbox");
  return c.text("file");
});
app.get("/a/:id", (c) => c.text("viewer"));
app.get("/s/:token", (c) => c.text("share"));
app.get("/a/:id/c/:token/*", (c) => {
  c.header("Content-Security-Policy", "frame-ancestors https://app.test");
  return c.text("content");
});
app.get("/redirect", () => Response.redirect("https://app.test/page", 302));

const csp = (res: Response) => res.headers.get("Content-Security-Policy");

describe("frame guard", () => {
  it("forbids framing on a non-content route", async () => {
    const res = await app.request("/page");
    expect(csp(res)).toBe("frame-ancestors 'none'");
    expect(res.headers.get("Referrer-Policy")).toBeNull();
  });

  it("keeps a route's own CSP and adds frame-ancestors", async () => {
    const res = await app.request("/files/x");
    expect(csp(res)).toBe("sandbox, frame-ancestors 'none'");
  });

  it("sends no referrer from the viewer and share pages", async () => {
    const responses = await Promise.all(
      ["/a/abc", "/s/hm_share_x"].map((path) => app.request(path))
    );
    for (const res of responses) {
      expect(csp(res)).toBe("frame-ancestors 'none'");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("leaves content paths to set their own frame-ancestors", async () => {
    const res = await app.request("/a/abc/c/tok/index.html");
    expect(csp(res)).toBe("frame-ancestors https://app.test");
  });

  it("guards a redirect, whose headers are immutable", async () => {
    const res = await app.request("/redirect");
    expect(res.status).toBe(302);
    expect(csp(res)).toBe("frame-ancestors 'none'");
  });
});

describe("R1.21a with the real content routes", () => {
  const real = new Hono<AppEnv>();
  real.use("*", frameGuard);
  mountArtifactContentRoutes(real, {
    bucket: () => ({ get: () => Promise.resolve(null) }),
    viewKey: () => "key",
    workspaceId: () => "ws",
  });
  real.get("/page", (c) => c.text("page"));
  const ID = "6f1c2f0e-8f0e-4c3a-9f37-2b3f3c1d9a10";

  it("a content response keeps its own frame-ancestors, a page gets none", async () => {
    const content = await real.request(`https://hm.test/a/${ID}/c/bad/x.js`);
    expect(content.status).toBe(401);
    const contentCsp = csp(content) ?? "";
    expect(contentCsp).toContain("frame-ancestors https://hm.test");
    expect(contentCsp).not.toContain("frame-ancestors 'none'");
    const page = await real.request("https://hm.test/page");
    expect(csp(page)).toBe("frame-ancestors 'none'");
  });
});
