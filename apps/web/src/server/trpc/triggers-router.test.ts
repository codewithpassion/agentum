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

const agentInput = {
  model: "fake",
  name: "Fake echo",
  runtime: "fake",
} as const;

const TRIGGER_PREFIX = "hm_trg_";

test("create returns an hm_trg_ secret, and list shows the trigger without it", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({ ...agentInput, name: "Echo" });

  const { secret, trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });
  expect(secret.startsWith(TRIGGER_PREFIX)).toBe(true);
  expect(trigger).toMatchObject({
    agentId: agent.id,
    agentName: "Echo",
    kind: "http",
    name: "webhook",
    revokedAt: null,
  });
  expect(trigger.tokenPrefix).toBe(secret.slice(0, TRIGGER_PREFIX.length + 4));

  const triggers = await caller.triggers.list({});
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toMatchObject({ id: trigger.id, name: "webhook" });
  expect(Object.keys(triggers[0] ?? {})).not.toContain("tokenHash");
  expect(Object.keys(triggers[0] ?? {})).not.toContain("secret");
  expect(JSON.stringify(triggers)).not.toContain(secret);
});

test("list filters by agentId", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const first = await caller.agents.create({ ...agentInput, name: "First" });
  const second = await caller.agents.create({ ...agentInput, name: "Second" });
  await caller.triggers.create({ agentId: first.id, name: "one" });
  const { trigger: onSecond } = await caller.triggers.create({
    agentId: second.id,
    name: "two",
  });

  const filtered = await caller.triggers.list({ agentId: second.id });
  expect(filtered.map((row) => row.id)).toEqual([onSecond.id]);
  expect(await caller.triggers.list({})).toHaveLength(2);
});

test("revoke sets revokedAt, and a second revoke keeps the first timestamp", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const { trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  await caller.triggers.revoke({ triggerId: trigger.id });
  const [afterFirst] = await caller.triggers.list({});
  expect(afterFirst?.revokedAt).not.toBeNull();

  // Wait so a second revoke would get a later timestamp if it overwrote.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await caller.triggers.revoke({ triggerId: trigger.id });
  const [afterSecond] = await caller.triggers.list({});
  expect(afterSecond?.revokedAt).toBe(afterFirst?.revokedAt ?? null);
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.triggers.create({ agentId: "missing", name: "webhook" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.triggers.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.triggers.revoke({ triggerId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a caller in an org outside ALLOWED_ORG_IDS gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_c", userId: "user_3" });

  await expect(
    caller.triggers.create({ agentId: "missing", name: "webhook" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.triggers.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.triggers.revoke({ triggerId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a user of another allowed org cannot see, revoke or create on the first org's triggers", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });
  const agent = await owner.agents.create(agentInput);
  const { trigger } = await owner.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  expect(await other.triggers.list({})).toEqual([]);
  await expect(
    other.triggers.revoke({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    other.triggers.create({ agentId: agent.id, name: "stolen" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const [still] = await owner.triggers.list({});
  expect(still?.revokedAt).toBeNull();
});
