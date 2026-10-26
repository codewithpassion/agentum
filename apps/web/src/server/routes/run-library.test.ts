import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import { systemClock } from "@repo/services/runs/types";
import type { Principal, Workspace } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { runLibraryRoutes } from "./run-library.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const WORKER_ENV = { RUN_TOKEN_KEY: KEY };
const TEXT = new TextEncoder();
const DECODE = new TextDecoder();

type User = Extract<Principal, { kind: "user" }>;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let userA: User;
let userB: User;

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
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
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
    relay: noopRelay,
    runTokenKey: KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/", runLibraryRoutes());

const userIn = async (clerkOrgId: string, userId: string): Promise<User> => {
  const workspace: Workspace | null = await composed.services.workspaces.forOrg(
    { clerkOrgId }
  );
  if (!workspace) {
    throw new Error(`${clerkOrgId} must be allowed`);
  }
  return { kind: "user", userId, via: "session", workspaceId: workspace.id };
};

beforeEach(async () => {
  db = migrated();
  composed = composeWith({
    allowedOrgIds: ["org_a", "org_b"],
    db,
    infra: infra(),
  });
  userA = await userIn("org_a", "user_a");
  userB = await userIn("org_b", "user_b");
});

const enrol = async (owner: User, name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(owner, {
    machineName: name,
  });
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled;
};

/** An agent on a fresh machine of the owner's workspace. */
const newAgent = async (owner: User, name: string): Promise<string> => {
  const { machineId } = await enrol(owner, `${name}-machine`);
  return (
    await composed.services.agents.create(owner, {
      machineId,
      model: "m",
      name,
      runtime: "machine",
    })
  ).id;
};

/** A run of the owner's agent, claimed by its machine. Returns the run id and its run token. */
const claimedRun = async (owner: User, agentId: string) => {
  const { runId } = await composed.services.runs.startRun(owner, {
    agentId,
    input: { fileIds: [], text: "hi" },
    session: { origin: "ui" },
  });
  const { machineId } = await composed.services.agents.get(owner, agentId);
  if (!machineId) {
    throw new Error("agent has no machine");
  }
  const claim = await composed.services.runs.claimRunForMachine(
    { kind: "machine", machineId, workspaceId: owner.workspaceId },
    runId,
    { platformUrl: "http://localhost" }
  );
  return { runId, runToken: claim.runToken };
};

/** A run in workspace A, for most tests. */
const runInA = async () => {
  const agentId = await newAgent(userA, "Box");
  await Promise.all(
    ["notes", "fresh", "gone.md", "docs"].map((path) =>
      composed.services.libraryAccess.setGrant(userA, agentId, path, "write")
    )
  );
  return claimedRun(userA, agentId);
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const libraryUrl = (runId: string, route: string, path?: string) => {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return `/api/runs/${runId}/library/${route}${query}`;
};

const listOf = (runId: string, token: string, path: string) =>
  app.request(
    libraryUrl(runId, "list", path),
    { headers: bearer(token) },
    WORKER_ENV
  );

const statOf = (runId: string, token: string, path: string) =>
  app.request(
    libraryUrl(runId, "stat", path),
    { headers: bearer(token) },
    WORKER_ENV
  );

const readOf = (runId: string, token: string, path: string) =>
  app.request(
    libraryUrl(runId, "file", path),
    { headers: bearer(token) },
    WORKER_ENV
  );

const writeOf = (
  runId: string,
  token: string,
  path: string,
  body: string,
  ifEtag?: string
) =>
  app.request(
    libraryUrl(runId, "file", path),
    {
      body: TEXT.encode(body),
      headers: {
        ...bearer(token),
        ...(ifEtag === undefined ? {} : { "X-Library-If-Etag": ifEtag }),
      },
      method: "PUT",
    },
    WORKER_ENV
  );

const deleteOf = (runId: string, token: string, path: string) =>
  app.request(
    libraryUrl(runId, "file", path),
    { headers: bearer(token), method: "DELETE" },
    WORKER_ENV
  );

const conflictOf = (runId: string, token: string, body: unknown) =>
  app.request(
    libraryUrl(runId, "conflicts"),
    {
      body: JSON.stringify(body),
      headers: { ...bearer(token), "Content-Type": "application/json" },
      method: "POST",
    },
    WORKER_ENV
  );

test("a run lists, stats and reads a file the user wrote", async () => {
  const { runId, runToken } = await runInA();
  const written = await composed.services.library.write(
    userA,
    "notes/a.md",
    TEXT.encode("hello")
  );

  const root = await listOf(runId, runToken, "");
  expect(root.status).toBe(200);
  const rootBody = (await root.json()) as {
    entries: Record<string, unknown>[];
  };
  expect(rootBody.entries).toEqual([
    { etag: null, kind: "dir", path: "notes", size: 0 },
  ]);

  const folder = await listOf(runId, runToken, "notes");
  const folderBody = (await folder.json()) as {
    entries: Record<string, unknown>[];
  };
  expect(folderBody.entries).toEqual([
    {
      etag: written.etag,
      kind: "file",
      path: "notes/a.md",
      size: 5,
    },
  ]);

  const stat = await statOf(runId, runToken, "notes/a.md");
  expect(stat.status).toBe(200);
  expect(await stat.json()).toEqual({
    entry: { etag: written.etag, kind: "file", path: "notes/a.md", size: 5 },
  });

  const read = await readOf(runId, runToken, "notes/a.md");
  expect(read.status).toBe(200);
  expect(read.headers.get("Cache-Control")).toBe("private, no-store");
  expect(read.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(read.headers.get("Content-Length")).toBe("5");
  expect(read.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(read.headers.get("X-Library-Etag")).toBe(written.etag);
  expect(DECODE.decode(await read.arrayBuffer())).toBe("hello");
});

test("a write with the current If-Etag succeeds with a new etag", async () => {
  const { runId, runToken } = await runInA();
  const first = await composed.services.library.write(
    userA,
    "notes/a.md",
    TEXT.encode("one")
  );

  const res = await writeOf(
    runId,
    runToken,
    "notes/a.md",
    "two",
    first.etag ?? ""
  );
  expect(res.status).toBe(200);
  const { etag } = (await res.json()) as { etag: string };
  expect(etag).not.toBe(first.etag);

  const current = await composed.services.library.read(userA, "notes/a.md");
  expect(current.entry.etag).toBe(etag);
  expect(DECODE.decode(current.bytes)).toBe("two");
});

test("a write with a stale If-Etag answers 409 and leaves the file alone", async () => {
  const { runId, runToken } = await runInA();
  const first = await composed.services.library.write(
    userA,
    "notes/a.md",
    TEXT.encode("one")
  );
  await composed.services.library.write(
    userA,
    "notes/a.md",
    TEXT.encode("newer")
  );

  const res = await writeOf(
    runId,
    runToken,
    "notes/a.md",
    "from run",
    first.etag ?? ""
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "The file changed since it was read",
  });

  const current = await composed.services.library.read(userA, "notes/a.md");
  expect(DECODE.decode(current.bytes)).toBe("newer");
});

test("a write with no If-Etag creates a new file", async () => {
  const { runId, runToken } = await runInA();

  const res = await writeOf(runId, runToken, "fresh/b.txt", "bytes");
  expect(res.status).toBe(200);
  const { etag } = (await res.json()) as { etag: string };

  const current = await composed.services.library.read(userA, "fresh/b.txt");
  expect(current.entry.etag).toBe(etag);
  expect(DECODE.decode(current.bytes)).toBe("bytes");
});

test("a delete removes the file", async () => {
  const { runId, runToken } = await runInA();
  await composed.services.library.write(userA, "gone.md", TEXT.encode("x"));

  const res = await deleteOf(runId, runToken, "gone.md");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
  expect((await statOf(runId, runToken, "gone.md")).status).toBe(404);
});

test("a missing path answers 404 on stat, and a folder answers 400 on read", async () => {
  const { runId, runToken } = await runInA();
  await composed.services.library.write(userA, "docs/a.md", TEXT.encode("x"));

  expect((await statOf(runId, runToken, "nope.md")).status).toBe(404);
  expect((await readOf(runId, runToken, "docs")).status).toBe(400);
});

test("a missing path query parameter answers 400", async () => {
  const { runId, runToken } = await runInA();

  const res = await app.request(
    `/api/runs/${runId}/library/file`,
    { headers: bearer(runToken) },
    WORKER_ENV
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "Expected a path query parameter.",
  });
});

test("the conflicts route appends a library.conflict event with the run id", async () => {
  const { runId, runToken } = await runInA();

  const res = await conflictOf(runId, runToken, {
    conflictPath: "/notes/a (conflict).md",
    path: "notes/a.md",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});

  const [event] = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "library.conflict"))
    .all();
  expect(event?.runId).toBe(runId);
  expect(JSON.parse(event?.payload ?? "null")).toEqual({
    conflictPath: "notes/a (conflict).md",
    path: "notes/a.md",
    runId,
  });
});

test("a conflicts body without both paths answers 400", async () => {
  const { runId, runToken } = await runInA();

  const res = await conflictOf(runId, runToken, { path: "notes/a.md" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "Expected JSON with path and conflictPath.",
  });
});

test("a run token for run A with run B's id in the URL answers 403", async () => {
  const runA = await runInA();
  const agentB = await newAgent(userA, "Tower");
  const runB = await claimedRun(userA, agentB);

  const res = await listOf(runB.runId, runA.runToken, "");
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "Not allowed." });
  expect((await readOf(runB.runId, runA.runToken, "x.md")).status).toBe(403);
});

test("no header, a cookie alone, or a garbage token answers 401", async () => {
  const { runId } = await runInA();

  const bare = await app.request(libraryUrl(runId, "list", ""), {}, WORKER_ENV);
  expect(bare.status).toBe(401);
  expect(await bare.json()).toEqual({ error: "Invalid run token." });

  const cookied = await app.request(
    libraryUrl(runId, "list", ""),
    { headers: { Cookie: "__session=abc" } },
    WORKER_ENV
  );
  expect(cookied.status).toBe(401);

  for (const token of ["hm_run_nonsense.sig", "hm_mach_not_a_run", "abc"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the order obvious
    const res = await listOf(runId, token, "");
    expect(res.status).toBe(401);
  }
});

test("a token signed with another key answers 401", async () => {
  const agentId = await newAgent(userA, "Box");
  const { runId, runToken } = await claimedRun(userA, agentId);
  const otherKey = await importRunTokenKey(
    btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
  );
  const forged = await signRunToken(otherKey, {
    agentId,
    issuedAt: Date.now(),
    runId,
    workspaceId: userA.workspaceId,
  });
  expect(runToken).not.toBe(forged);

  expect((await listOf(runId, forged, "")).status).toBe(401);
});

test("a run in workspace B never sees workspace A's files", async () => {
  await composed.services.library.write(userA, "secret.md", TEXT.encode("a"));
  const agentB = await newAgent(userB, "Tower");
  const runB = await claimedRun(userB, agentB);

  expect((await statOf(runB.runId, runB.runToken, "secret.md")).status).toBe(
    404
  );
  expect((await readOf(runB.runId, runB.runToken, "secret.md")).status).toBe(
    404
  );
  const list = await listOf(runB.runId, runB.runToken, "");
  expect(await list.json()).toEqual({ entries: [] });
});

test("an ungranted folder is hidden and cannot be written", async () => {
  const { runId, runToken } = await runInA();
  await composed.services.library.write(
    userA,
    "private/a",
    TEXT.encode("secret")
  );
  expect((await readOf(runId, runToken, "private/a")).status).toBe(404);
  expect((await listOf(runId, runToken, "private")).status).toBe(404);
  expect((await writeOf(runId, runToken, "private/a", "no")).status).toBe(403);
});
