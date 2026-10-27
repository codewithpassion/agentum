import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { frameGuard } from "./frame-guard.ts";

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
