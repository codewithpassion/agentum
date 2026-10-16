import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a", "org_b"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

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
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("a user creates a skill for an agent and the list shows it", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  expect(await caller.skills.list({ agentId: agent.id })).toEqual([]);

  const created = await caller.skills.create({
    agentId: agent.id,
    name: "write-brief",
  });
  expect(created).toEqual({ path: `skills/${agent.id}/write-brief/SKILL.md` });

  const listed = await caller.skills.list({ agentId: agent.id });
  expect(listed).toEqual([
    {
      description:
        "Describe what this skill does and when the agent should use it.",
      folder: "write-brief",
      name: "write-brief",
      path: `skills/${agent.id}/write-brief/SKILL.md`,
      problem: null,
      scope: "agent",
    },
  ]);
});

test("creating a skill with a taken name is a CONFLICT", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  await caller.skills.create({ agentId: agent.id, name: "write-brief" });

  await expect(
    caller.skills.create({ agentId: agent.id, name: "write-brief" })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a bad skill name is a BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  await expect(
    caller.skills.create({ agentId: agent.id, name: "Bad Name" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.skills.list({ agentId: "any" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.skills.create({ agentId: "any", name: "x" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("an agent of another workspace is NOT_FOUND", async () => {
  const composed = servicesFor();
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);
  const agent = await other.agents.create({
    model: "fake",
    name: "Heron",
    runtime: "fake",
  });
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );

  await expect(caller.skills.list({ agentId: agent.id })).rejects.toMatchObject(
    { code: "NOT_FOUND" }
  );
  await expect(
    caller.skills.create({ agentId: agent.id, name: "sneaky" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
