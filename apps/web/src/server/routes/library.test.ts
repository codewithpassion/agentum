import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { libraryRoutes } from "./library.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

interface Session {
  orgId: string | null;
  userId: string | null;
}
const USER_A: Session = { orgId: "org_a", userId: "user_a" };
const USER_B: Session = { orgId: "org_b", userId: "user_b" };

let db: ReturnType<typeof migrated>;
let composed: Composed;
let session: Session | null;

const infra = (): Infra => ({
  atomic: sqliteAtomic(db),
  blobs: {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  },
  clock: systemClock,
  devFakeRuntime: false,
  fileBlobs: memoryFileBlobs(),
  relay: noopRelay,
  runTokenKey: KEY,
});

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/", libraryRoutes({ session: () => session }));

beforeEach(() => {
  db = migrated();
  session = USER_A;
  composed = composeWith({
    allowedOrgIds: ["org_a", "org_b"],
    db,
    infra: infra(),
  });
});

const principalOf = async (who: Session) => {
  const principal = await composed.services.workspaces.sessionPrincipal({
    orgId: who.orgId,
    userId: who.userId ?? "",
  });
  if (!principal) {
    throw new Error("The session has no workspace");
  }
  return principal;
};

const download = (path: string | null) => {
  const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
  return app.request(`/api/library/download${query}`, {}, {});
};

test("a signed-in user downloads the bytes of a library file as an attachment", async () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  await composed.services.library.write(
    await principalOf(USER_A),
    "docs/a.bin",
    bytes
  );

  const res = await download("docs/a.bin");

  expect(res.status).toBe(200);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(res.headers.get("Content-Length")).toBe(String(bytes.byteLength));
  expect(res.headers.get("Content-Disposition")).toBe(
    `attachment; filename="a.bin"; filename*=UTF-8''a.bin`
  );
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
});

test("no session gives 401", async () => {
  await composed.services.library.write(
    await principalOf(USER_A),
    "docs/a.bin",
    new Uint8Array([1])
  );
  session = null;

  const res = await download("docs/a.bin");

  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Sign in required." });
});

test("a user of another workspace gets 404 for the path", async () => {
  await composed.services.library.write(
    await principalOf(USER_A),
    "docs/a.bin",
    new Uint8Array([1])
  );
  session = USER_B;

  const res = await download("docs/a.bin");

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Not found." });
});

test("a missing file gives 404", async () => {
  const res = await download("docs/missing.bin");

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Not found." });
});

test("no path gives 400", async () => {
  const res = await download(null);

  expect(res.status).toBe(400);
});
