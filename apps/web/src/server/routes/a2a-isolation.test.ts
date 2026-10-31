import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  type A2aFixture,
  createA2aFixture,
  textMessage,
} from "./a2a-fixture.ts";
import { deskRoutes } from "./desk.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";

const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const env = {
  ALLOWED_ORG_IDS: "org_a",
  PUBLIC_BASE_URL: "https://hm.test",
  RUN_TOKEN_KEY,
} as unknown as Env;

let f: A2aFixture;
let token: string;
let publicId: string;
let app: Hono<AppEnv>;

beforeEach(async () => {
  f = await createA2aFixture();
  const agent = await f.publish("echo");
  ({ publicId } = agent);
  ({ token } = await f.connect(agent));
  // The `/mcp` and `/api/desk` routes as the app mounts them, over the same services.
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", f.composed);
    await next();
  });
  app.route(
    "/mcp",
    mcpRoutes({
      clientName: () => () => Promise.resolve(null),
      dev: false,
      isOrgMember: () => () => Promise.resolve(true),
      verifyOAuthToken: () => () => Promise.resolve(null),
    })
  );
  app.route(
    "/api/desk",
    deskRoutes({ isOrgMember: () => () => Promise.resolve(true) })
  );
});

describe("an hm_a2a_ key works nowhere but /a2a", () => {
  test("the key is a valid credential under its own agent's path", async () => {
    const res = await f.rpc(
      publicId,
      token,
      "SendMessage",
      textMessage("m1", "hi")
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("TASK_STATE_COMPLETED");
  });

  test("the platform MCP server refuses it", async () => {
    const res = await app.request(
      "https://hm.test/mcp",
      {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Host: "hm.test",
        },
        method: "POST",
      },
      env
    );
    expect(res.status).toBe(401);
  });

  test("the desk API refuses it", async () => {
    const res = await app.request(
      "/api/desk/requests/req-1/decision",
      {
        body: JSON.stringify({ decision: "allow_once" }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-On-Behalf-Of": "u2@example.com",
        },
        method: "POST",
      },
      env
    );
    expect(res.status).toBe(401);
  });
});

describe("/a2a on the app's real wiring", () => {
  const serverSource = readFileSync(
    join(import.meta.dir, "..", "..", "server.ts"),
    "utf8"
  );

  test("server.ts mounts /a2a before the page fallback that Clerk's page handling sits behind", () => {
    const mount = serverSource.indexOf("mountA2aRoutes(app, composeServices)");
    const fallback = serverSource.indexOf('app.all("*"');
    expect(mount).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(mount);
  });

  test("server.ts gives /a2a no csrf check", () => {
    const csrfLines = serverSource
      .split("\n")
      .filter(
        (line) => line.includes("csrf()") && !line.trimStart().startsWith("//")
      );
    expect(csrfLines.length).toBeGreaterThan(0);
    for (const line of csrfLines) {
      expect(line).not.toContain("/a2a");
    }
  });

  test("a cross-site form post is not blocked as csrf", async () => {
    const res = await f.app.request(`/a2a/${publicId}/rpc`, {
      body: "a=b",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      method: "POST",
    });
    expect(res.status).not.toBe(403);
    expect(res.headers.get("content-type")).toContain("json");
  });

  test("nothing under /a2a falls through to the pages", async () => {
    for (const path of [
      "/a2a",
      "/a2a/x",
      `/a2a/${publicId}`,
      `/a2a/${publicId}/nope`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one path at a time
      const res = await f.app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("json");
    }
  });
});
