import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a"];
const DAY_START = "2026-10-26T00:00:00.000Z";

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
  };
};

const callerFor = async (session: {
  orgId?: string | null;
  userId: string | null;
}) =>
  appRouter.createCaller(
    await buildContext({
      composed: composeWith({
        db,
        infra: infra(),
      }),
      session,
    })
  );

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.desk.get({ dayStart: DAY_START })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.desk.needsYouCount()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("a caller with a user but no org gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });

  await expect(caller.desk.get({ dayStart: DAY_START })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.desk.needsYouCount()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("desk.get rejects a dayStart that is not an ISO time", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.desk.get({ dayStart: "yesterday" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a signed-in caller gets an empty desk", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.desk.get({ dayStart: DAY_START })).toEqual({
    done: [],
    doneMore: 0,
    needsYou: [],
    running: [],
  });
  expect(await caller.desk.needsYouCount()).toBe(0);
});
