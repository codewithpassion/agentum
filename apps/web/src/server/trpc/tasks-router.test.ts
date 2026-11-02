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

  await expect(caller.tasks.get({ runId: "run_1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.tasks.list({ limit: 10 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.tasks.files({ runId: "run_1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("a caller with a user but no org gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });

  await expect(caller.tasks.get({ runId: "run_1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.tasks.list({ limit: 10 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("tasks.list rejects a limit outside 1 to 100", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.tasks.list({ limit: 0 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(caller.tasks.list({ limit: 101 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("tasks.list rejects an unknown input key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.tasks.list({ extra: true, limit: 10 } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("tasks.get rejects an empty run id", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.tasks.get({ runId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("a signed-in caller gets an empty task list", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.tasks.list({ limit: 10 })).toEqual([]);
});

test("an unknown run is NOT_FOUND", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.tasks.get({ runId: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("tasks.files rejects an empty run id", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.tasks.files({ runId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("tasks.files on an unknown run is NOT_FOUND", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.tasks.files({ runId: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
