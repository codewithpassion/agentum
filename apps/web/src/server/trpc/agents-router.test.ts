import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];
const KEY = "sk-or-test-0000";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
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
    secretsKey: SECRETS_KEY,
  };
};

const servicesFor = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("providerKeys reports false for a workspace with no key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.agents.providerKeys()).toEqual({ openrouter: false });
});

test("providerKeys reports true once the workspace has a key", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { workspaceId } = await caller.me();

  await composed.services.modelKeys.set(
    {
      kind: "user",
      userId: "user_1",
      via: "session",
      workspaceId,
    },
    { apiKey: KEY, provider: "openrouter" }
  );

  expect(await caller.agents.providerKeys()).toEqual({ openrouter: true });
});

test("providerKeys carries booleans only, never the key or its hint", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { workspaceId } = await caller.me();
  await composed.services.modelKeys.set(
    { kind: "user", userId: "user_1", via: "session", workspaceId },
    { apiKey: KEY, provider: "openrouter" }
  );

  const result = await caller.agents.providerKeys();

  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(result)).not.toContain("0000");
  for (const value of Object.values(result)) {
    expect(typeof value).toBe("boolean");
  }
});

test("another workspace does not see the first workspace's key", async () => {
  const composed = servicesFor();
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" }, composed);
  const { workspaceId } = await owner.me();
  await composed.services.modelKeys.set(
    { kind: "user", userId: "user_1", via: "session", workspaceId },
    { apiKey: KEY, provider: "openrouter" }
  );

  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);

  expect(await other.agents.providerKeys()).toEqual({ openrouter: false });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.agents.providerKeys()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("address procedures check and reserve across workspaces with authentication", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);
  const agent = await caller.agents.create({
    model: "m",
    name: "Address",
    runtime: "fake",
  });
  expect(await caller.agents.checkAddress({ local: "address" })).toEqual({
    available: true,
  });
  expect(
    await caller.agents.reserveAddress({ agentId: agent.id, local: "address" })
  ).toMatchObject({ emailLocal: "address" });
  expect(await other.agents.checkAddress({ local: "address" })).toEqual({
    available: false,
  });
  await expect(
    other.agents.reserveAddress({ agentId: agent.id, local: "other" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const anonymous = await callerFor({ orgId: "org_a", userId: null }, composed);
  await expect(
    anonymous.agents.checkAddress({ local: "address" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    anonymous.agents.reserveAddress({ agentId: agent.id, local: "address" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("restore uses archive authorization and restores into the active list", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const agent = await caller.agents.create({
    model: "m",
    name: "Archived",
    runtime: "fake",
  });
  await caller.agents.archive({ id: agent.id });
  expect(await caller.agents.list({})).toEqual([]);
  expect(await caller.agents.list({ includeArchived: true })).toHaveLength(1);
  const anonymous = await callerFor({ orgId: "org_a", userId: null }, composed);
  await expect(
    anonymous.agents.restore({ agentId: agent.id })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);
  await expect(
    other.agents.restore({ agentId: agent.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await caller.agents.restore({ agentId: agent.id })).toMatchObject({
    status: "active",
  });
  expect(await caller.agents.list({})).toHaveLength(1);
});
