import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import { systemClock } from "@repo/services/runs/types";
import type { Principal, Workspace } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { skillsRoutes } from "./skills.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const WORKER_ENV = { RUN_TOKEN_KEY: KEY };
const TEXT = new TextEncoder();

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceA: Workspace;
let userA: Extract<Principal, { kind: "user" }>;

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
app.route("/", skillsRoutes());

beforeEach(async () => {
  db = migrated();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: infra(),
  });
  const a = await composed.services.workspaces.forOrg({ clerkOrgId: "org_a" });
  if (!a) {
    throw new Error("org_a must be allowed");
  }
  workspaceA = a;
  userA = { kind: "user", userId: "user_a", via: "session", workspaceId: a.id };
});

const enrol = async (name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(userA, {
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

/** An agent on a fresh machine. */
const newAgent = async (name: string): Promise<string> => {
  const { machineId } = await enrol(`${name}-machine`);
  return (
    await composed.services.agents.create(userA, {
      machineId,
      model: "m",
      name,
      runtime: "machine",
    })
  ).id;
};

/** A run of an agent, claimed by its machine. Returns the run id and its run token. */
const claimedRun = async (agentId: string) => {
  const { runId } = await composed.services.runs.startRun(userA, {
    agentId,
    input: { fileIds: [], text: "hi" },
    session: { origin: "ui" },
  });
  const { machineId } = await composed.services.agents.get(userA, agentId);
  if (!machineId) {
    throw new Error("agent has no machine");
  }
  const claim = await composed.services.runs.claimRunForMachine(
    { kind: "machine", machineId, workspaceId: workspaceA.id },
    runId,
    { platformUrl: "http://localhost" }
  );
  return { runId, runToken: claim.runToken };
};

const writeSkill = (path: string, text: string) =>
  composed.services.library.write(userA, path, TEXT.encode(text));

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const list = (runId: string, headers: Record<string, string>) =>
  app.request(`/api/runs/${runId}/skills`, { headers }, WORKER_ENV);

const readFile = (
  runId: string,
  path: string | null,
  headers: Record<string, string>
) => {
  const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
  return app.request(
    `/api/runs/${runId}/skills/file${query}`,
    { headers },
    WORKER_ENV
  );
};

test("a run token lists its agent's own skill and the shared skill, and reads a file", async () => {
  const agentId = await newAgent("Box");
  await writeSkill(`skills/${agentId}/shout/SKILL.md`, "# shout");
  await writeSkill("skills/_shared/greet/SKILL.md", "# greet");
  const { runId, runToken } = await claimedRun(agentId);

  const res = await list(runId, bearer(runToken));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: { path: string }[] };
  expect(body.files.map((entry) => entry.path)).toEqual([
    "greet/SKILL.md",
    "shout/SKILL.md",
  ]);

  const file = await readFile(runId, "shout/SKILL.md", bearer(runToken));
  expect(file.status).toBe(200);
  expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(file.headers.get("Content-Length")).toBe("7");
  expect(file.headers.get("Cache-Control")).toBe("private, no-store");
  expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await file.text()).toBe("# shout");

  const shared = await readFile(runId, "greet/SKILL.md", bearer(runToken));
  expect(shared.status).toBe(200);
  expect(await shared.text()).toBe("# greet");
});

test("another agent's skill in the same workspace is not listed and cannot be read", async () => {
  const agentId = await newAgent("Box");
  const otherAgentId = await newAgent("Tower");
  await writeSkill(`skills/${otherAgentId}/only-other/SKILL.md`, "secret");
  const { runId, runToken } = await claimedRun(agentId);

  const res = await list(runId, bearer(runToken));
  const body = (await res.json()) as { files: { path: string }[] };
  expect(body.files).toEqual([]);

  const byName = await readFile(runId, "only-other/SKILL.md", bearer(runToken));
  expect(byName.status).toBe(404);

  const byTraversal = await readFile(
    runId,
    `../${otherAgentId}/only-other/SKILL.md`,
    bearer(runToken)
  );
  expect(byTraversal.status).toBe(400);
});

test("a run token for run A with run B's id in the URL answers 404", async () => {
  const agentA = await newAgent("Box");
  const agentB = await newAgent("Tower");
  await writeSkill(`skills/${agentB}/other/SKILL.md`, "b");
  const runA = await claimedRun(agentA);
  const runB = await claimedRun(agentB);

  expect((await list(runB.runId, bearer(runA.runToken))).status).toBe(404);
  expect(
    (await readFile(runB.runId, "other/SKILL.md", bearer(runA.runToken))).status
  ).toBe(404);
});

test("no header answers 401 even with a cookie session", async () => {
  const agentId = await newAgent("Box");
  const { runId } = await claimedRun(agentId);

  const bare = await list(runId, {});
  expect(bare.status).toBe(401);
  expect(await bare.json()).toEqual({ error: "Invalid run token." });

  const cookied = await list(runId, { Cookie: "__session=abc" });
  expect(cookied.status).toBe(401);
  expect((await readFile(runId, "x/SKILL.md", {})).status).toBe(401);
});

test("a garbage token and a non-run token answer 401", async () => {
  const agentId = await newAgent("Box");
  const { runId } = await claimedRun(agentId);

  for (const token of ["hm_run_nonsense.sig", "hm_mach_not_a_run", "abc"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the order obvious
    const res = await list(runId, bearer(token));
    expect(res.status).toBe(401);
  }
});

test("a token signed with another key answers 401", async () => {
  const agentId = await newAgent("Box");
  const { runId, runToken } = await claimedRun(agentId);
  const otherKey = await importRunTokenKey(
    btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
  );
  const forged = await signRunToken(otherKey, {
    agentId,
    issuedAt: Date.now(),
    runId,
    workspaceId: workspaceA.id,
  });
  expect(runToken).not.toBe(forged);

  expect((await list(runId, bearer(forged))).status).toBe(401);
});

test("a missing path answers 400", async () => {
  const agentId = await newAgent("Box");
  const { runId, runToken } = await claimedRun(agentId);

  const res = await readFile(runId, null, bearer(runToken));
  expect(res.status).toBe(400);
  expect(await res.json()).toHaveProperty("error");
});

test("a path with a dot-dot segment answers 400", async () => {
  const agentId = await newAgent("Box");
  await writeSkill(`skills/${agentId}/shout/SKILL.md`, "# shout");
  const { runId, runToken } = await claimedRun(agentId);

  const res = await readFile(
    runId,
    "shout/../shout/SKILL.md",
    bearer(runToken)
  );
  expect(res.status).toBe(400);
});

test("a skill tree over 200 files answers 400 on the list", async () => {
  const agentId = await newAgent("Box");
  for (let i = 0; i < 201; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: writes land in order so the count is exact
    await writeSkill(`skills/${agentId}/big/f${i}.txt`, "x");
  }
  const { runId, runToken } = await claimedRun(agentId);

  const res = await list(runId, bearer(runToken));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "Skills are limited to 200 files and 5 MB",
  });
});
