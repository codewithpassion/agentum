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

test("createEnrollToken returns a code, and list shows an enrolled machine", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );

  const { code } = await caller.machines.createEnrollToken({
    machineName: "laptop",
  });
  expect(code.startsWith("hm_enr_")).toBe(true);
  expect(await caller.machines.list()).toEqual([]);

  await composed.services.machines.enroll({ code, singleUser: false });
  const machines = await caller.machines.list();
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({ name: "laptop", status: "offline" });
});

test("revoke marks the machine revoked", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { code } = await caller.machines.createEnrollToken({
    machineName: "laptop",
  });
  await composed.services.machines.enroll({ code, singleUser: false });
  const [machine] = await caller.machines.list();
  if (!machine) {
    throw new Error("the enrolled machine is not listed");
  }

  await caller.machines.revoke({ machineId: machine.id });

  const [after] = await caller.machines.list();
  expect(after?.status).toBe("revoked");
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.machines.createEnrollToken({ machineName: "laptop" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.machines.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.machines.revoke({ machineId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
