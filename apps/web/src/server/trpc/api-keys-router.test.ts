import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a"];

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

test("create returns an hm_key_ secret, and list shows the key without it", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  const { key, secret } = await caller.apiKeys.create({
    access: "read",
    name: "laptop",
  });
  expect(secret.startsWith("hm_key_")).toBe(true);

  const keys = await caller.apiKeys.list();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatchObject({
    access: "read",
    id: key.id,
    name: "laptop",
    revokedAt: null,
  });
  expect(keys[0]?.prefix).toBe(secret.slice(0, "hm_key_".length + 4));
  expect(Object.keys(keys[0] ?? {})).not.toContain("secret");
  expect(JSON.stringify(keys)).not.toContain(secret);
});

test("revoke sets revokedAt on the key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const { key } = await caller.apiKeys.create({
    access: "write",
    name: "agent",
  });

  await caller.apiKeys.revoke({ keyId: key.id });

  const [after] = await caller.apiKeys.list();
  expect(after?.revokedAt).not.toBeNull();
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.apiKeys.create({ access: "read", name: "laptop" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.apiKeys.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.apiKeys.revoke({ keyId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
