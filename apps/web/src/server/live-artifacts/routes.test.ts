// biome-ignore-all lint/suspicious/noMisplacedAssertion: assertions in trusted dependency doubles verify forwarded authentication.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Composed } from "../compose";
import type { AppEnv } from "../routes/groups";
import { liveRoomRoutes } from "./routes";

const principal = {
  agentId: "a1",
  kind: "run",
  runId: "r1",
  workspaceId: "w1",
} as const;
const artifactId = crypto.randomUUID();
const path = `http://localhost/api/rooms/${artifactId}?ticket=signed-ticket`;
const setup = (
  options: { authenticated?: boolean; admit?: () => Promise<void> } = {}
) => {
  let admissions = 0,
    forwards = 0,
    clerk = 0;
  const composed = {
    services: {
      liveArtifacts: {
        admit: async () => {
          admissions += 1;
          await options.admit?.();
        },
      },
    },
  } as unknown as Composed;
  const routes = liveRoomRoutes({
    authenticate: async () => {
      await Promise.resolve();
      return options.authenticated === false ? null : principal;
    },
    compose: () => composed,
    room: async (_namespace, scope) => {
      expect(scope).toEqual({ artifactId, workspaceId: "w1" });
      await Promise.resolve();
      return {
        fetch: (request: Request) => {
          forwards += 1;
          expect(request.headers.get("Authorization")).toBe(
            "Bearer real-run-token"
          );
          expect(request.headers.get("Cookie")).toBe("session=real-cookie");
          return Promise.resolve(new Response("admitted"));
        },
      } as unknown as Awaited<
        ReturnType<typeof import("./namespace").roomStub>
      >;
    },
  });
  const app = new Hono<AppEnv>();
  app.route("/", routes);
  app.use("*", async (_c, next) => {
    clerk += 1;
    await next();
  });
  const env = {
    LIVE_ARTIFACT_MAINTENANCE: {
      getByName: () => ({ start: () => Promise.resolve() }),
    },
  } as unknown as Env;
  return {
    counts: () => ({ admissions, clerk, forwards }),
    request: (url = path, headers: Record<string, string> = {}) =>
      app.request(
        url,
        {
          headers: {
            Authorization: "Bearer real-run-token",
            Cookie: "session=real-cookie",
            Upgrade: "websocket",
            ...headers,
          },
        },
        env
      ),
  };
};
test("room route is before Clerk and forwards the real initial credential context", async () => {
  const h = setup();
  expect((await h.request()).status).toBe(200);
  expect(h.counts()).toEqual({ admissions: 1, clerk: 0, forwards: 1 });
});
test("a signed ticket cannot replace authentication and stale admission cannot reach the room", async () => {
  const absent = setup({ authenticated: false });
  expect((await absent.request()).status).toBe(401);
  expect(absent.counts().forwards).toBe(0);
  const stale = setup({
    admit: () => Promise.reject(new Error("revoked private details")),
  });
  const denied = await stale.request();
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe("Access denied");
  expect(stale.counts().forwards).toBe(0);
});
test("cross-origin upgrades, missing tickets and non-upgrades fail before admission", async () => {
  const h = setup();
  expect(
    (await h.request(path, { Origin: "https://attacker.example" })).status
  ).toBe(403);
  expect((await h.request(path.split("?")[0])).status).toBe(403);
  expect((await h.request(path, { Upgrade: "http" })).status).toBe(426);
  expect(h.counts().admissions).toBe(0);
});
