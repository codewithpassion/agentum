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

test("newestDaemonVersion reads the published version, and needs a session", async () => {
  const composed = composeWith({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    infra: {
      ...infra(),
      latestDaemonVersion: () => Promise.resolve("0.1.0+abc1234"),
    },
  });
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  expect(await caller.machines.newestDaemonVersion()).toBe("0.1.0+abc1234");

  const none = await callerFor({ orgId: "org_a", userId: "user_1" });
  expect(await none.machines.newestDaemonVersion()).toBeNull();

  const anonymous = await callerFor({ orgId: "org_a", userId: null });
  await expect(anonymous.machines.newestDaemonVersion()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
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

test("createEnrollToken for a computer makes a computer-only machine", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );

  const { code } = await caller.machines.createEnrollToken({
    machineName: "desk",
    role: "computer",
  });
  expect(code.startsWith("hm_enr_")).toBe(true);

  await composed.services.machines.enroll({
    arch: "x64",
    clientVersion: "1",
    code,
    hostname: "h",
    os: "linux",
    role: "computer",
  });
  const machines = await caller.machines.list();
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    computerStatus: "offline",
    roles: ["computer"],
  });
});

test("createEnrollToken for a computer adds the role to a daemon machine", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const daemon = await caller.machines.createEnrollToken({
    machineName: "laptop",
  });
  await composed.services.machines.enroll({
    code: daemon.code,
    singleUser: false,
  });
  const [before] = await caller.machines.list();
  if (!before) {
    throw new Error("the enrolled machine is not listed");
  }

  const { code } = await caller.machines.createEnrollToken({
    machineId: before.id,
    role: "computer",
  });
  await composed.services.machines.enroll({
    arch: "x64",
    clientVersion: "1",
    code,
    hostname: "h",
    os: "linux",
    role: "computer",
  });

  const machines = await caller.machines.list();
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    id: before.id,
    roles: ["agent_host", "computer"],
  });
});

test("attachComputer attaches a computer to a cloud agent and detaches it with null", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { workspaceId } = await caller.me();
  const principal = {
    kind: "user" as const,
    userId: "user_1",
    via: "session" as const,
    workspaceId,
  };
  const agent = await composed.services.agents.create(principal, {
    model: "claude-sonnet-4-5",
    name: "Alpha",
    runtime: "cloud",
  });
  const { code } = await caller.machines.createEnrollToken({
    machineName: "desk",
    role: "computer",
  });
  await composed.services.machines.enroll({
    arch: "x64",
    clientVersion: "1",
    code,
    hostname: "h",
    os: "linux",
    role: "computer",
  });
  const [computer] = await caller.machines.list();
  if (!computer) {
    throw new Error("the computer is not listed");
  }

  await expect(
    caller.machines.attachComputer({
      agentId: agent.id,
      machineId: computer.id,
    })
  ).resolves.toBeUndefined();
  await expect(
    caller.machines.attachComputer({ agentId: agent.id, machineId: null })
  ).resolves.toBeUndefined();
});

test("attachComputer refuses a machine without the computer role", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { workspaceId } = await caller.me();
  const agent = await composed.services.agents.create(
    { kind: "user", userId: "user_1", via: "session", workspaceId },
    { model: "claude-sonnet-4-5", name: "Alpha", runtime: "cloud" }
  );
  const daemon = await caller.machines.createEnrollToken({
    machineName: "plain",
  });
  await composed.services.machines.enroll({
    code: daemon.code,
    singleUser: false,
  });
  const [plain] = await caller.machines.list();
  if (!plain) {
    throw new Error("the enrolled machine is not listed");
  }

  await expect(
    caller.machines.attachComputer({ agentId: agent.id, machineId: plain.id })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a caller without a session gets UNAUTHORIZED from attachComputer", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.machines.attachComputer({ agentId: "x", machineId: null })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
