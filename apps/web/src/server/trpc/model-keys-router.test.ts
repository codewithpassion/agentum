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
const PROVIDER = "openrouter" as const;
const KEY = "sk-or-v1-test-0000";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

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
    secretsKey: SECRETS_KEY,
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("status shows the key's last four characters after set, never the key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.modelKeys.status({ provider: PROVIDER })).toMatchObject({
    configured: false,
    hint: null,
  });

  const setResult = await caller.modelKeys.set({
    apiKey: KEY,
    provider: PROVIDER,
  });

  const status = await caller.modelKeys.status({ provider: PROVIDER });
  expect(status).toMatchObject({ configured: true, hint: "0000" });
  expect(JSON.stringify(status)).not.toContain(KEY);
  expect(JSON.stringify(status)).not.toContain("sk-or-v1-test");
  expect(JSON.stringify(setResult)).not.toContain(KEY);
  expect(JSON.stringify(setResult)).not.toContain("sk-or-v1-test");
});

test("remove clears the key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.modelKeys.set({ apiKey: KEY, provider: PROVIDER });

  const removed = await caller.modelKeys.remove({ provider: PROVIDER });

  expect(removed).toMatchObject({ configured: false, hint: null });
  expect(await caller.modelKeys.status({ provider: PROVIDER })).toMatchObject({
    configured: false,
  });
});

test("set refuses an empty or blank key, and stores nothing", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.modelKeys.set({ apiKey: "", provider: PROVIDER })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.modelKeys.set({ apiKey: "   ", provider: PROVIDER })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  expect(await caller.modelKeys.status({ provider: PROVIDER })).toMatchObject({
    configured: false,
  });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.modelKeys.status({ provider: PROVIDER })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.modelKeys.set({ apiKey: KEY, provider: PROVIDER })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.modelKeys.remove({ provider: PROVIDER })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a key set in one workspace is not visible from another", async () => {
  const composed = servicesFor();
  const callerA = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const callerB = await callerFor(
    { orgId: "org_b", userId: "user_2" },
    composed
  );

  await callerA.modelKeys.set({ apiKey: KEY, provider: PROVIDER });

  expect(await callerA.modelKeys.status({ provider: PROVIDER })).toMatchObject({
    configured: true,
  });
  expect(await callerB.modelKeys.status({ provider: PROVIDER })).toMatchObject({
    configured: false,
    hint: null,
  });
});
