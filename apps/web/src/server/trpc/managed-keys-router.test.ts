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
const KEY = "sk-ant-test-0000";
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

  expect(await caller.managedKeys.status()).toMatchObject({
    configured: false,
    hint: null,
  });

  await caller.managedKeys.set({ apiKey: KEY });

  const status = await caller.managedKeys.status();
  expect(status).toMatchObject({ configured: true, hint: "0000" });
  expect(JSON.stringify(status)).not.toContain(KEY);
  expect(JSON.stringify(status)).not.toContain("sk-ant-test");
});

test("set refuses a key without the sk-ant- prefix, and stores nothing", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.managedKeys.set({ apiKey: "sk-test-0000" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  expect(await caller.managedKeys.status()).toMatchObject({
    configured: false,
  });
});

test("remove clears the key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.managedKeys.set({ apiKey: KEY });

  const status = await caller.managedKeys.remove();

  expect(status).toMatchObject({ configured: false, hint: null });
  expect(await caller.managedKeys.status()).toMatchObject({
    configured: false,
  });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.managedKeys.status()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.managedKeys.set({ apiKey: KEY })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.managedKeys.remove()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
