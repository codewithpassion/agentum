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

test("map requires a workspace session", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });
  await expect(caller.map.graph({ days: 7 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
test("map validates its window and returns a graph", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  // @ts-expect-error Exercise runtime validation for an untyped client.
  await expect(caller.map.graph({ days: 0 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await caller.map.graph({ days: 7 })).toEqual({ nodes: [], wires: [] });
});
