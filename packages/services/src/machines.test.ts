import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  machineCredentials,
  machineEnrollTokens,
  machines,
} from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import type { RunStatus } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import type { HelloMessage } from "@repo/protocol/computer";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService, type EventsService } from "./events.ts";
import { type MachineRelayPort, noopRelay } from "./machines/types.ts";
import {
  createMachinesService,
  ENROLL_TOKEN_PREFIX,
  MACHINE_CREDENTIAL_PREFIX,
} from "./machines.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const MINUTE = 60 * 1000;

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const system: Principal = { kind: "system" };
const machinePrincipal = (
  machineId: string,
  workspaceId = WORKSPACE
): Principal => ({ kind: "machine", machineId, workspaceId });

type Db = ReturnType<typeof migrated>;
type Service = ReturnType<typeof createMachinesService>;

let db: Db;
let nowMs: number;
let clock: Clock;
let events: EventsService;
let relayCalls: { cancel: string[][]; offer: unknown[][]; revoke: string[] };
let relay: MachineRelayPort;
let service: Service;

const seedWorkspace = (id: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

/** A machine row written directly, for tests that need a machine in a given state. */
const seedMachine = (
  id: string,
  {
    capabilities = "{}",
    computerStatus = null,
    name = id,
    status = "offline",
    workspaceId = WORKSPACE,
  }: {
    capabilities?: string;
    computerStatus?: "offline" | "online" | null;
    name?: string;
    status?: "offline" | "online" | "revoked";
    workspaceId?: string;
  } = {}
) =>
  db
    .insert(machines)
    .values({
      capabilities,
      computerStatus,
      createdAt: START,
      credentialHash: `hash-${id}`,
      enrolledBy: "u1",
      id,
      lastSeenAt: null,
      name,
      singleUser: false,
      status,
      workspaceId,
    })
    .run();

const machineRow = (id: string) =>
  db.select().from(machines).where(eq(machines.id, id)).get();

const machineStatus = (id: string) => machineRow(id)?.status;

const eventsOf = (
  type:
    | "machine.online"
    | "machine.offline"
    | "computer.online"
    | "computer.offline"
    | "agent.updated"
) => events.query(system, WORKSPACE, { types: [type] });

/** Builds the service. */
const build = (latestDaemonVersion?: () => Promise<string | null>): Service =>
  createMachinesService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    latestDaemonVersion,
    relay,
  });

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
  };
  const store = new Map<string, string>();
  events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  relayCalls = { cancel: [], offer: [], revoke: [] };
  relay = {
    ...noopRelay,
    announce: () => Promise.resolve(),
    cancel: (machineId, runId) => {
      relayCalls.cancel.push([machineId, runId]);
      return Promise.resolve();
    },
    offer: (machineId, offer) => {
      relayCalls.offer.push([machineId, offer]);
      return Promise.resolve();
    },
    revoke: (machineId) => {
      relayCalls.revoke.push(machineId);
      return Promise.resolve();
    },
  };
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
  service = build();
});

test("createEnrollToken returns a 15 minute code and stores only its hash", async () => {
  const minted = await service.createEnrollToken(user, {
    machineName: "  Laptop  ",
  });

  expect(minted.code.startsWith(ENROLL_TOKEN_PREFIX)).toBe(true);
  expect(minted.expiresAt).toBe(
    new Date(Date.parse(START) + 15 * MINUTE).toISOString()
  );
  const rows = db.select().from(machineEnrollTokens).all();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({
    createdBy: "u1",
    expiresAt: minted.expiresAt,
    machineName: "Laptop",
    usedAt: null,
    workspaceId: WORKSPACE,
  });
  expect(row?.tokenHash).toBe(await hashToken(minted.code));
  expect(JSON.stringify(rows)).not.toContain(minted.code);

  await expect(
    service.createEnrollToken(system, { machineName: "Laptop" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.createEnrollToken(machinePrincipal("m1"), { machineName: "Laptop" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.createEnrollToken(user, { machineName: "   " })
  ).rejects.toThrow();
  expect(db.select().from(machineEnrollTokens).all()).toHaveLength(1);
});

/** Mints a code and enrols with it. Hashes are computed here so the test body needs no await in its loop. */
const enrollOne = async (machineName: string, singleUser: boolean) => {
  const { code } = await service.createEnrollToken(user, { machineName });
  const enrolled = await service.enroll({ code, singleUser });
  if (!enrolled) {
    throw new Error("enroll returned null");
  }
  return {
    codeHash: await hashToken(code),
    credential: enrolled.credential,
    credentialHash: await hashToken(enrolled.credential),
    machineId: enrolled.machineId,
    machineName,
    singleUser,
  };
};

test("enroll trades a code for a machine and a credential stored only as a hash", async () => {
  const enrolled = await Promise.all([
    enrollOne("Shared box", true),
    enrollOne("Laptop", false),
  ]);
  for (const result of enrolled) {
    expect(result.credential.startsWith(MACHINE_CREDENTIAL_PREFIX)).toBe(true);

    const row = machineRow(result.machineId);
    expect(row).toMatchObject({
      enrolledBy: "u1",
      lastSeenAt: null,
      name: result.machineName,
      singleUser: result.singleUser,
      status: "offline",
      workspaceId: WORKSPACE,
    });
    expect(row?.credentialHash).toBe(result.credentialHash);
    expect(JSON.stringify(row)).not.toContain(result.credential);

    const token = db
      .select()
      .from(machineEnrollTokens)
      .where(eq(machineEnrollTokens.tokenHash, result.codeHash))
      .get();
    expect(token?.usedAt).toBe(START);
  }
});

test("enroll returns null for a used, unknown or expired code", async () => {
  const { code } = await service.createEnrollToken(user, { machineName: "A" });
  expect(await service.enroll({ code, singleUser: false })).not.toBeNull();
  expect(await service.enroll({ code, singleUser: false })).toBeNull();

  expect(
    await service.enroll({
      code: `${ENROLL_TOKEN_PREFIX}unknown`,
      singleUser: false,
    })
  ).toBeNull();

  const stale = await service.createEnrollToken(user, { machineName: "B" });
  nowMs += 15 * MINUTE + 1;
  expect(
    await service.enroll({ code: stale.code, singleUser: false })
  ).toBeNull();

  expect(db.select().from(machineEnrollTokens).all()).toHaveLength(2);
  expect(db.select().from(machines).all()).toHaveLength(1);
});

test("two concurrent enrolls on one code leave exactly one winner and one machine", async () => {
  const { code } = await service.createEnrollToken(user, { machineName: "A" });
  const results = await Promise.all([
    service.enroll({ code, singleUser: false }),
    service.enroll({ code, singleUser: false }),
  ]);
  expect(results.filter((result) => result !== null)).toHaveLength(1);
  expect(db.select().from(machines).all()).toHaveLength(1);
});

const FAILING_ENROLL_BODIES = {
  computer: (code: string) => computerBody(code),
  daemon: (code: string) => ({ code, singleUser: false }),
  roles: (code: string) => ({
    arch: "amd64" as const,
    clientVersion: "0.1.0",
    code,
    hostname: "box",
    os: "linux" as const,
    roles: ["agent_host" as const],
    singleUser: false,
  }),
};

/** Mints a code for `role`, fails the machine write, and reports what happened to the code. */
const enrollThroughFailedWrite = async (
  role: "agent_host" | "computer",
  body: (code: string) => Parameters<Service["enroll"]>[0]
) => {
  const failing = createMachinesService({
    atomic: () => Promise.reject(new Error("write failed")),
    clock,
    db,
    events,
    relay,
  });
  const { code } = await service.createEnrollToken(user, {
    machineName: "Box",
    role,
  });
  const failure = await failing.enroll(body(code)).catch((error) => error);
  const row = db
    .select({ usedAt: machineEnrollTokens.usedAt })
    .from(machineEnrollTokens)
    .where(eq(machineEnrollTokens.tokenHash, await hashToken(code)))
    .get();
  return {
    failure: String(failure),
    retry: await service.enroll(body(code)),
    usedAt: row?.usedAt,
  };
};

test("a code stays unspent when the machine insert fails, for the daemon body", async () => {
  const outcome = await enrollThroughFailedWrite(
    "agent_host",
    FAILING_ENROLL_BODIES.daemon
  );
  expect(outcome.failure).toContain("write failed");
  expect(outcome.usedAt).toBeNull();
  expect(outcome.retry).not.toBeNull();
});

test("a code stays unspent when the machine insert fails, for the computer body", async () => {
  const outcome = await enrollThroughFailedWrite(
    "computer",
    FAILING_ENROLL_BODIES.computer
  );
  expect(outcome.failure).toContain("write failed");
  expect(outcome.usedAt).toBeNull();
  expect(outcome.retry).not.toBeNull();
});

test("a code stays unspent when the machine insert fails, for the roles body", async () => {
  const outcome = await enrollThroughFailedWrite(
    "agent_host",
    FAILING_ENROLL_BODIES.roles
  );
  expect(outcome.failure).toContain("write failed");
  expect(outcome.usedAt).toBeNull();
  expect(outcome.retry).not.toBeNull();
});

test("adding the computer role to a machine that is gone leaves the code unspent", async () => {
  seedMachine("m1");
  const { code } = await service.createEnrollToken(user, {
    machineId: "m1",
    role: "computer",
  });
  db.update(machines)
    .set({ status: "revoked" })
    .where(eq(machines.id, "m1"))
    .run();
  expect(await service.enroll(computerBody(code))).toBeNull();
  expect(
    db
      .select({ usedAt: machineEnrollTokens.usedAt })
      .from(machineEnrollTokens)
      .get()
  ).toEqual({ usedAt: null });
});

test("credentials and codes are still issued as hm_, and ag_ ones are accepted for the flip", async () => {
  // Installed daemons check these prefixes and know only hm_ (see token-prefixes.ts).
  expect(MACHINE_CREDENTIAL_PREFIX).toBe("hm_mach_");
  expect(ENROLL_TOKEN_PREFIX).toBe("hm_enr_");
  const { code } = await service.createEnrollToken(user, { machineName: "A" });
  const enrolled = await service.enroll({ code, singleUser: false });
  if (!enrolled) {
    throw new Error("enroll returned null");
  }
  const renamed = `ag_mach_${enrolled.credential.slice("hm_mach_".length)}`;
  db.update(machines)
    .set({ credentialHash: await hashToken(renamed) })
    .where(eq(machines.id, enrolled.machineId))
    .run();

  expect(await service.authenticate(`Bearer ${renamed}`)).toMatchObject({
    kind: "machine",
    machineId: enrolled.machineId,
  });
});

/** Deletes the workspace row with its machines still there, which D1's foreign keys would refuse. */
const dropWorkspaceRow = () => {
  db.client.run("PRAGMA foreign_keys = OFF");
  db.delete(workspaces).where(eq(workspaces.id, WORKSPACE)).run();
};

test("authenticate accepts only a live machine credential in a workspace with a row", async () => {
  const { code } = await service.createEnrollToken(user, { machineName: "A" });
  const enrolled = await service.enroll({ code, singleUser: false });
  if (!enrolled) {
    throw new Error("enroll returned null");
  }

  expect(await service.authenticate(`Bearer ${enrolled.credential}`)).toEqual({
    kind: "machine",
    machineId: enrolled.machineId,
    workspaceId: WORKSPACE,
  });

  expect(
    await service.authenticate(`Bearer ${MACHINE_CREDENTIAL_PREFIX}wrong`)
  ).toBeNull();
  expect(await service.authenticate(null)).toBeNull();
  expect(await service.authenticate(`Bearer ${code}`)).toBeNull();

  await service.revoke(user, enrolled.machineId);
  expect(
    await service.authenticate(`Bearer ${enrolled.credential}`)
  ).toBeNull();
});

test("authenticate gives null for a machine whose workspace has no row", async () => {
  const { code } = await service.createEnrollToken(user, { machineName: "A" });
  const enrolled = await service.enroll({ code, singleUser: false });
  if (!enrolled) {
    throw new Error("enroll returned null");
  }
  dropWorkspaceRow();
  expect(
    await service.authenticate(`Bearer ${enrolled.credential}`)
  ).toBeNull();
});

test("list returns the caller's workspace machines by name, without the credential hash", async () => {
  seedMachine("m-zeta", { name: "zeta" });
  seedMachine("m-alpha", {
    capabilities: JSON.stringify({ runtime: "claude", version: "1.2" }),
    name: "alpha",
    status: "online",
  });
  seedMachine("m-other", { name: "middle", workspaceId: OTHER_WORKSPACE });

  const listed = await service.list(user);
  expect(listed.map((machine) => machine.name)).toEqual(["alpha", "zeta"]);
  for (const machine of listed) {
    expect(machine).not.toHaveProperty("credentialHash");
  }
  expect(listed[0]).toMatchObject({
    capabilities: { runtime: "claude", version: "1.2" },
    id: "m-alpha",
    status: "online",
    workspaceId: WORKSPACE,
  });

  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});

test("revoke ends the credential, closes sockets and reports an online machine once", async () => {
  seedMachine("m-online", { name: "online", status: "online" });
  seedMachine("m-offline", { name: "offline" });

  await service.revoke(user, "m-online");
  expect(machineStatus("m-online")).toBe("revoked");
  expect(relayCalls.revoke).toEqual(["m-online"]);
  const offlineEvents = await eventsOf("machine.offline");
  expect(offlineEvents).toHaveLength(1);
  expect(offlineEvents[0]?.payload).toEqual({
    machineId: "m-online",
    name: "online",
    reason: "revoked",
  });

  await service.revoke(user, "m-offline");
  expect(machineStatus("m-offline")).toBe("revoked");
  expect(relayCalls.revoke).toEqual(["m-online", "m-offline"]);
  expect(await eventsOf("machine.offline")).toHaveLength(1);

  await service.revoke(user, "m-online");
  expect(relayCalls.revoke).toEqual(["m-online", "m-offline", "m-online"]);
  expect(await eventsOf("machine.offline")).toHaveLength(1);

  await expect(service.revoke(otherUser, "m-offline")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.revoke(otherUser, "m-offline")).rejects.toBeInstanceOf(
    ServiceError
  );
  await expect(
    service.revoke(machinePrincipal("m-offline"), "m-offline")
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("newestDaemonVersion reads the published version for a member, and is null without one", async () => {
  const withRelease = build(() => Promise.resolve("0.2.0+def5678"));
  expect(await withRelease.newestDaemonVersion(user)).toBe("0.2.0+def5678");
  expect(await service.newestDaemonVersion(user)).toBeNull();
  await expect(withRelease.newestDaemonVersion(system)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("markOnline stores the daemon version and a ping without one keeps it", async () => {
  seedMachine("m1", { name: "laptop" });
  const me = machinePrincipal("m1");

  await service.markOnline(me, {
    capabilities: { runtime: "claude" },
    daemonVersion: "0.1.0+abc1234",
  });
  expect(machineRow("m1")).toMatchObject({ daemonVersion: "0.1.0+abc1234" });
  await service.markOnline(me);
  expect(machineRow("m1")).toMatchObject({ daemonVersion: "0.1.0+abc1234" });
});

test("markOnline brings a machine online once and stores what the daemon sent", async () => {
  seedMachine("m1", { name: "laptop" });
  seedMachine("m-revoked", { status: "revoked" });
  const me = machinePrincipal("m1");

  nowMs += 5000;
  expect(
    await service.markOnline(me, { capabilities: { runtime: "claude" } })
  ).toBe("ok");
  expect(machineRow("m1")).toMatchObject({
    capabilities: JSON.stringify({ runtime: "claude" }),
    lastSeenAt: clock.now().toISOString(),
    status: "online",
  });
  const onlineEvents = await eventsOf("machine.online");
  expect(onlineEvents).toHaveLength(1);
  expect(onlineEvents[0]?.payload).toEqual({ machineId: "m1", name: "laptop" });

  nowMs += MINUTE;
  expect(await service.markOnline(me)).toBe("ok");
  expect(await eventsOf("machine.online")).toHaveLength(1);
  expect(machineRow("m1")).toMatchObject({
    capabilities: JSON.stringify({ runtime: "claude" }),
    lastSeenAt: clock.now().toISOString(),
  });

  expect(await service.markOnline(machinePrincipal("m-revoked"))).toBe(
    "revoked"
  );
  expect(machineStatus("m-revoked")).toBe("revoked");

  await expect(service.markOnline(user)).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    await service.markOnline(machinePrincipal("m1", OTHER_WORKSPACE))
  ).toBe("revoked");
});

test("markOffline takes an online machine offline with one event and leaves revoked ones alone", async () => {
  seedMachine("m1", { name: "laptop", status: "online" });
  seedMachine("m-revoked", { status: "revoked" });

  await service.markOffline(machinePrincipal("m1"), "silent");
  expect(machineStatus("m1")).toBe("offline");
  const offlineEvents = await eventsOf("machine.offline");
  expect(offlineEvents).toHaveLength(1);
  expect(offlineEvents[0]?.payload).toEqual({
    machineId: "m1",
    name: "laptop",
    reason: "silent",
  });

  await service.markOffline(machinePrincipal("m1"), "disconnected");
  expect(await eventsOf("machine.offline")).toHaveLength(1);

  await service.markOffline(machinePrincipal("m-revoked"), "disconnected");
  expect(machineStatus("m-revoked")).toBe("revoked");
  expect(await eventsOf("machine.offline")).toHaveLength(1);
});

test("pendingOffers returns the queued and offered runs of this machine's agents, oldest first", async () => {
  seedMachine("m1", { name: "one" });
  seedMachine("m2", { name: "two" });
  seedMachine("m3", { name: "three", workspaceId: OTHER_WORKSPACE });
  const agents = createAgentsService({ db, events });
  const onM1 = await agents.create(user, {
    machineId: "m1",
    model: "m",
    name: "On one",
    runtime: "machine",
  });
  const onM2 = await agents.create(user, {
    machineId: "m2",
    model: "m",
    name: "On two",
    runtime: "machine",
  });
  const onM3 = await agents.create(otherUser, {
    machineId: "m3",
    model: "m",
    name: "On three",
    runtime: "machine",
  });

  const seedRun = (
    id: string,
    agentId: string,
    workspaceId: string,
    status: RunStatus,
    createdAt: string,
    pendingFiles: string | null = null
  ) => {
    const sessionId = `s-${id}`;
    db.insert(sessionRows)
      .values({
        actorId: agentId,
        actorKind: "agent",
        agentId,
        createdAt,
        id: sessionId,
        origin: "ui",
        workspaceId,
      })
      .run();
    db.insert(runRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
        createdAt,
        id,
        inputText: "hi",
        pendingFiles,
        sessionId,
        status,
        workspaceId,
      })
      .run();
  };
  const at = (seconds: number) =>
    new Date(Date.parse(START) + seconds * 1000).toISOString();

  seedRun("offered", onM1.id, WORKSPACE, "offered", at(2));
  seedRun("queued", onM1.id, WORKSPACE, "queued", at(0));
  seedRun("running", onM1.id, WORKSPACE, "running", at(1));
  seedRun("done", onM1.id, WORKSPACE, "done", at(3));
  seedRun("queued-files", onM1.id, WORKSPACE, "queued", at(4), '[{"id":"f"}]');
  seedRun("other-machine", onM2.id, WORKSPACE, "queued", at(0));
  seedRun("other-workspace", onM3.id, OTHER_WORKSPACE, "queued", at(0));

  expect(await service.pendingOffers(machinePrincipal("m1"))).toEqual([
    { agentId: onM1.id, runId: "queued" },
    { agentId: onM1.id, runId: "offered" },
  ]);
  await expect(service.pendingOffers(user)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

const computerHello = (desktop = false): HelloMessage => ({
  arch: "arm64",
  capabilities: {
    desktop,
    desktop_unavailable_reason: null,
    git: true,
    python3: true,
    skills: false,
  },
  hostname: "box",
  os: "linux",
  protocol_version: 1,
  run_as_user: "agent",
  type: "hello",
  version: "1.2.3",
  workdir: "/home/agent/sessions",
});

const computerBody = (code: string) => ({
  arch: "arm64",
  clientVersion: "1.2.3",
  code,
  hostname: "box",
  os: "linux",
  role: "computer" as const,
});

/** A computer-only machine, enrolled through a code. */
const enrollComputerOnly = async (machineName: string) => {
  const { code } = await service.createEnrollToken(user, {
    machineName,
    role: "computer",
  });
  const enrolled = await service.enroll(computerBody(code));
  if (!enrolled) {
    throw new Error("computer enroll returned null");
  }
  return { ...enrolled, code };
};

/** A daemon machine that also holds the computer role. */
const enrollBoth = async (machineName: string) => {
  const daemon = await enrollOne(machineName, false);
  const { code } = await service.createEnrollToken(user, {
    machineId: daemon.machineId,
    role: "computer",
  });
  const computer = await service.enroll(computerBody(code));
  if (!computer) {
    throw new Error("computer enroll returned null");
  }
  return { computer, daemon };
};

test("createEnrollToken stores the role and takes a machine's own name for the computer role", async () => {
  seedMachine("m1", { name: "Laptop" });
  const minted = await service.createEnrollToken(user, {
    machineId: "m1",
    role: "computer",
  });
  const [row] = db.select().from(machineEnrollTokens).all();
  expect(row).toMatchObject({
    machineId: "m1",
    machineName: "Laptop",
    role: "computer",
    tokenHash: await hashToken(minted.code),
  });

  await service.createEnrollToken(user, {
    machineName: "New",
    role: "computer",
  });
  await service.createEnrollToken(user, { machineName: "Daemon" });
  expect(
    db
      .select({
        machineId: machineEnrollTokens.machineId,
        role: machineEnrollTokens.role,
      })
      .from(machineEnrollTokens)
      .all()
      .slice(1)
  ).toEqual([
    { machineId: null, role: "computer" },
    { machineId: null, role: "agent_host" },
  ]);
});

test("createEnrollToken refuses a daemon code for an existing machine and a machine that cannot take the computer role", async () => {
  seedMachine("m1");
  seedMachine("m-computer", { computerStatus: "offline" });
  seedMachine("m-revoked", { status: "revoked" });
  seedMachine("m-other", { workspaceId: OTHER_WORKSPACE });

  await expect(
    service.createEnrollToken(user, { machineId: "m1", role: "agent_host" })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.createEnrollToken(user, {
      machineId: "m-computer",
      role: "computer",
    })
  ).rejects.toMatchObject({ code: "conflict" });
  await Promise.all(
    ["m-revoked", "m-other", "missing"].map((machineId) =>
      expect(
        service.createEnrollToken(user, { machineId, role: "computer" })
      ).rejects.toMatchObject({ code: "not_found" })
    )
  );
  await expect(
    service.createEnrollToken(user, { role: "computer" })
  ).rejects.toThrow();
  expect(db.select().from(machineEnrollTokens).all()).toHaveLength(0);
});

test("enroll makes a computer-only machine whose credential opens the computer role only", async () => {
  const enrolled = await enrollComputerOnly("Desk");

  expect(enrolled.credential.startsWith(MACHINE_CREDENTIAL_PREFIX)).toBe(true);
  const row = machineRow(enrolled.machineId);
  expect(row).toMatchObject({
    computerStatus: "offline",
    enrolledBy: "u1",
    name: "Desk",
    status: "offline",
    workspaceId: WORKSPACE,
  });
  // No bearer token hashes to the daemon credential of a computer-only machine.
  expect(row?.credentialHash).not.toBe(await hashToken(enrolled.credential));
  const [credential] = db.select().from(machineCredentials).all();
  expect(credential).toMatchObject({
    credentialHash: await hashToken(enrolled.credential),
    machineId: enrolled.machineId,
    role: "computer",
    workspaceId: WORKSPACE,
  });
  expect(JSON.stringify([row, credential])).not.toContain(enrolled.credential);

  expect(
    await service.authenticate(`Bearer ${enrolled.credential}`, "computer")
  ).toEqual({
    kind: "machine",
    machineId: enrolled.machineId,
    workspaceId: WORKSPACE,
  });
  expect(
    await service.authenticate(`Bearer ${enrolled.credential}`)
  ).toBeNull();
  expect(
    await service.authenticate(`Bearer ${enrolled.credential}`, "agent_host")
  ).toBeNull();

  const [listed] = await service.list(user);
  expect(listed).toMatchObject({
    computerStatus: "offline",
    roles: ["computer"],
  });
});

test("a code only enrols the role it was minted for, and a refused body leaves it unspent", async () => {
  const daemonCode = (
    await service.createEnrollToken(user, { machineName: "A" })
  ).code;
  const computerCode = (
    await service.createEnrollToken(user, {
      machineName: "B",
      role: "computer",
    })
  ).code;

  expect(await service.enroll(computerBody(daemonCode))).toBeNull();
  expect(
    await service.enroll({ code: computerCode, singleUser: false })
  ).toBeNull();
  expect(db.select().from(machines).all()).toHaveLength(0);
  expect(
    db
      .select()
      .from(machineEnrollTokens)
      .all()
      .map((token) => token.usedAt)
  ).toEqual([null, null]);

  expect(
    await service.enroll({ code: daemonCode, singleUser: false })
  ).not.toBeNull();
  expect(await service.enroll(computerBody(computerCode))).not.toBeNull();
});

test("enroll adds the computer role to a daemon machine and keeps both credentials apart", async () => {
  const { computer, daemon } = await enrollBoth("Both");

  expect(computer.machineId).toBe(daemon.machineId);
  expect(db.select().from(machines).all()).toHaveLength(1);
  expect(machineRow(daemon.machineId)).toMatchObject({
    computerStatus: "offline",
    credentialHash: daemon.credentialHash,
  });
  expect(
    await service.authenticate(`Bearer ${computer.credential}`, "computer")
  ).toMatchObject({ machineId: daemon.machineId });
  expect(
    await service.authenticate(`Bearer ${computer.credential}`)
  ).toBeNull();
  expect(
    await service.authenticate(`Bearer ${daemon.credential}`)
  ).toMatchObject({
    machineId: daemon.machineId,
  });
  expect(
    await service.authenticate(`Bearer ${daemon.credential}`, "computer")
  ).toBeNull();
  dropWorkspaceRow();
  expect(
    await service.authenticate(`Bearer ${computer.credential}`, "computer")
  ).toBeNull();

  const [listed] = await service.list(user);
  expect(listed?.roles).toEqual(["agent_host", "computer"]);
});

test("enroll adds no computer to a machine that was revoked or took one since the code was minted", async () => {
  seedMachine("m-revoked");
  seedMachine("m-twice");
  const revokedCode = (
    await service.createEnrollToken(user, {
      machineId: "m-revoked",
      role: "computer",
    })
  ).code;
  const firstCode = (
    await service.createEnrollToken(user, {
      machineId: "m-twice",
      role: "computer",
    })
  ).code;
  const secondCode = (
    await service.createEnrollToken(user, {
      machineId: "m-twice",
      role: "computer",
    })
  ).code;
  await service.revoke(user, "m-revoked");

  expect(await service.enroll(computerBody(revokedCode))).toBeNull();
  expect(await service.enroll(computerBody(firstCode))).not.toBeNull();
  expect(await service.enroll(computerBody(secondCode))).toBeNull();
  expect(db.select().from(machineCredentials).all()).toHaveLength(1);
});

test("authenticate refuses a revoked machine for either role", async () => {
  const { computer, daemon } = await enrollBoth("Both");
  await service.revoke(user, daemon.machineId);

  expect(await service.authenticate(`Bearer ${daemon.credential}`)).toBeNull();
  expect(
    await service.authenticate(`Bearer ${computer.credential}`, "computer")
  ).toBeNull();
});

test("markComputerOnline stores the hello, writes one computer.online and leaves the daemon alone", async () => {
  const { machineId } = await enrollComputerOnly("Desk");
  const me = machinePrincipal(machineId);

  nowMs += 5000;
  expect(await service.markComputerOnline(me, computerHello(true))).toBe("ok");
  const row = machineRow(machineId);
  expect(row).toMatchObject({
    computerLastSeenAt: clock.now().toISOString(),
    computerStatus: "online",
    lastSeenAt: null,
    status: "offline",
  });
  expect(JSON.parse(row?.computerCapabilities ?? "null")).toEqual({
    arch: "arm64",
    clientVersion: "1.2.3",
    desktop: true,
    os: "linux",
    workdir: "/home/agent/sessions",
  });
  const online = await eventsOf("computer.online");
  expect(online).toHaveLength(1);
  expect(online[0]?.payload).toEqual({ machineId });

  nowMs += MINUTE;
  expect(await service.markComputerOnline(me, computerHello())).toBe("ok");
  expect(await eventsOf("computer.online")).toHaveLength(1);
  expect(machineRow(machineId)?.computerLastSeenAt).toBe(
    clock.now().toISOString()
  );
  expect(
    JSON.parse(machineRow(machineId)?.computerCapabilities ?? "{}")
  ).toMatchObject({
    desktop: false,
  });

  await expect(
    service.markComputerOnline(user, computerHello())
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("markComputerOnline answers revoked for a revoked machine, a machine without a computer and another workspace", async () => {
  seedMachine("m-revoked", { computerStatus: "offline", status: "revoked" });
  seedMachine("m-daemon");
  seedMachine("m-computer", { computerStatus: "offline" });

  expect(
    await service.markComputerOnline(
      machinePrincipal("m-revoked"),
      computerHello()
    )
  ).toBe("revoked");
  expect(
    await service.markComputerOnline(
      machinePrincipal("m-daemon"),
      computerHello()
    )
  ).toBe("revoked");
  expect(
    await service.markComputerOnline(
      machinePrincipal("m-computer", OTHER_WORKSPACE),
      computerHello()
    )
  ).toBe("revoked");
  expect(machineRow("m-revoked")?.computerStatus).toBe("offline");
  expect(machineRow("m-daemon")?.computerStatus).toBeNull();
  expect(await eventsOf("computer.online")).toHaveLength(0);
});

test("markComputerOffline takes an online computer offline once", async () => {
  seedMachine("m1", { computerStatus: "online", status: "online" });
  seedMachine("m2", { computerStatus: "offline" });

  await service.markComputerOffline(machinePrincipal("m1"));
  expect(machineRow("m1")).toMatchObject({
    computerStatus: "offline",
    status: "online",
  });
  const offline = await eventsOf("computer.offline");
  expect(offline).toHaveLength(1);
  expect(offline[0]?.payload).toEqual({ machineId: "m1" });

  await service.markComputerOffline(machinePrincipal("m1"));
  await service.markComputerOffline(machinePrincipal("m2"));
  expect(await eventsOf("computer.offline")).toHaveLength(1);
  await expect(service.markComputerOffline(user)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("revoke ends both roles, closes the sockets and reports an online computer once", async () => {
  const { computer, daemon } = await enrollBoth("Both");
  await service.markComputerOnline(
    machinePrincipal(computer.machineId),
    computerHello()
  );

  await service.revoke(user, daemon.machineId);
  expect(machineRow(daemon.machineId)).toMatchObject({
    computerStatus: "offline",
    status: "revoked",
  });
  expect(relayCalls.revoke).toEqual([daemon.machineId]);
  expect(await eventsOf("computer.offline")).toHaveLength(1);
  expect(
    await service.authenticate(`Bearer ${computer.credential}`, "computer")
  ).toBeNull();
  expect(await service.authenticate(`Bearer ${daemon.credential}`)).toBeNull();
  expect(
    await service.markComputerOnline(
      machinePrincipal(daemon.machineId),
      computerHello()
    )
  ).toBe("revoked");

  await service.revoke(user, daemon.machineId);
  expect(await eventsOf("computer.offline")).toHaveLength(1);
});

test("list tells a daemon machine from a computer-only one and a machine with both", async () => {
  await enrollOne("Daemon", false);
  await enrollComputerOnly("Desk");
  await enrollBoth("Both");

  const listed = await service.list(user);
  expect(
    listed.map(({ name, roles, computerStatus }) => ({
      computerStatus,
      name,
      roles,
    }))
  ).toEqual([
    {
      computerStatus: "offline",
      name: "Both",
      roles: ["agent_host", "computer"],
    },
    { computerStatus: null, name: "Daemon", roles: ["agent_host"] },
    { computerStatus: "offline", name: "Desk", roles: ["computer"] },
  ]);
  for (const machine of listed) {
    expect(machine).not.toHaveProperty("credentialHash");
  }
});

const createAgent = (
  runtime: "cloud" | "managed" | "machine",
  name: string,
  principal: Principal = user
) =>
  createAgentsService({ db, events }).create(principal, {
    ...(runtime === "machine" ? { machineId: "m-daemon" } : {}),
    model: "claude-sonnet-4-5",
    name,
    runtime,
  });

const computerOf = (agentId: string) =>
  db.select().from(agentRows).where(eq(agentRows.id, agentId)).get()
    ?.computerMachineId;

test("attachComputer attaches a computer to a cloud and a managed agent and detaches it again", async () => {
  seedMachine("m-computer", { computerStatus: "offline" });
  seedMachine("m-both", { computerStatus: "online", status: "online" });
  const cloud = await createAgent("cloud", "Cloud");
  const managed = await createAgent("managed", "Managed");

  await service.attachComputer(user, cloud.id, "m-computer");
  await service.attachComputer(user, managed.id, "m-both");
  expect(computerOf(cloud.id)).toBe("m-computer");
  expect(computerOf(managed.id)).toBe("m-both");
  const updated = await eventsOf("agent.updated");
  expect(updated).toHaveLength(2);
  expect(updated[0]).toMatchObject({ agentId: cloud.id });
  expect(updated[0]?.payload).toEqual({ changed: ["computerMachineId"] });

  await service.attachComputer(user, cloud.id, "m-computer");
  expect(await eventsOf("agent.updated")).toHaveLength(2);

  await service.attachComputer(user, cloud.id, null);
  expect(computerOf(cloud.id)).toBeNull();
  expect(await eventsOf("agent.updated")).toHaveLength(3);
  await service.attachComputer(user, managed.id, "m-computer");
  expect(computerOf(managed.id)).toBe("m-computer");
});

test("attachComputer refuses a machine agent, a machine without a computer role and a machine of another workspace", async () => {
  seedMachine("m-daemon");
  seedMachine("m-computer", { computerStatus: "offline" });
  seedMachine("m-revoked", { computerStatus: "offline", status: "revoked" });
  seedMachine("m-other", {
    computerStatus: "offline",
    workspaceId: OTHER_WORKSPACE,
  });
  const onMachine = await createAgent("machine", "On machine");
  const cloud = await createAgent("cloud", "Cloud");

  await expect(
    service.attachComputer(user, onMachine.id, "m-computer")
  ).rejects.toMatchObject({ code: "invalid" });
  await Promise.all(
    ["m-daemon", "m-revoked", "m-other", "missing"].map((machineId) =>
      expect(
        service.attachComputer(user, cloud.id, machineId)
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
  await expect(
    service.attachComputer(otherUser, cloud.id, "m-other")
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.attachComputer(user, "missing", "m-computer")
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.attachComputer(system, cloud.id, "m-computer")
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.attachComputer(
      machinePrincipal("m-computer"),
      cloud.id,
      "m-computer"
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(computerOf(cloud.id)).toBeNull();
  expect(await eventsOf("agent.updated")).toHaveLength(0);
});

test("attachComputer detaches a computer from an agent that is no longer cloud or managed", async () => {
  seedMachine("m-computer", { computerStatus: "offline" });
  const agent = await createAgent("cloud", "Cloud");
  await service.attachComputer(user, agent.id, "m-computer");
  db.update(agentRows)
    .set({ machineId: "m-computer", runtime: "machine" })
    .where(eq(agentRows.id, agent.id))
    .run();

  await service.attachComputer(user, agent.id, null);
  expect(computerOf(agent.id)).toBeNull();
});

test("attachComputer gives a computer to one agent at a time", async () => {
  seedMachine("m-computer", { computerStatus: "offline" });
  const first = await createAgent("cloud", "First");
  const second = await createAgent("managed", "Second");

  await service.attachComputer(user, first.id, "m-computer");
  await expect(
    service.attachComputer(user, second.id, "m-computer")
  ).rejects.toMatchObject({ code: "conflict" });
  expect(computerOf(second.id)).toBeNull();

  await service.attachComputer(user, first.id, null);
  await service.attachComputer(user, second.id, "m-computer");
  expect(computerOf(second.id)).toBe("m-computer");
});

test("the desktop reads need a live computer of the caller's workspace", async () => {
  seedMachine("m-computer", { computerStatus: "online" });
  seedMachine("m-daemon");
  seedMachine("m-revoked", { computerStatus: "online", status: "revoked" });
  seedMachine("m-other", {
    computerStatus: "online",
    workspaceId: OTHER_WORKSPACE,
  });

  await expect(
    service.desktopStatus(user, "m-computer")
  ).resolves.toMatchObject({ connected: false });

  await Promise.all(
    ["m-other", "m-revoked", "m-daemon", "missing"].flatMap((machineId) => [
      expect(service.desktopStatus(user, machineId)).rejects.toMatchObject({
        code: "not_found",
        message: "Machine not found",
      }),
      expect(service.clipboardRead(user, machineId)).rejects.toMatchObject({
        code: "not_found",
      }),
      expect(
        service.clipboardWrite(user, machineId, "x")
      ).rejects.toMatchObject({ code: "not_found" }),
    ])
  );
  await Promise.all(
    [system, machinePrincipal("m-computer")].flatMap((principal) => [
      expect(
        service.desktopStatus(principal, "m-computer")
      ).rejects.toBeInstanceOf(ForbiddenError),
      expect(
        service.clipboardRead(principal, "m-computer")
      ).rejects.toBeInstanceOf(ForbiddenError),
      expect(
        service.clipboardWrite(principal, "m-computer", "x")
      ).rejects.toBeInstanceOf(ForbiddenError),
    ])
  );
});

test("desktopStatus returns the relay's status for the machine asked for", async () => {
  seedMachine("m-computer", { computerStatus: "online" });
  const asked: string[] = [];
  relay = {
    ...relay,
    computerStatus: (machineId) => {
      asked.push(machineId);
      return Promise.resolve({
        capabilities: null,
        connected: true,
        control: null,
        hostname: "box",
        inFlightExec: 0,
        lastSeenAt: 5,
        queued: 0,
        version: "1",
        workdir: null,
      });
    },
  };
  service = build();

  await expect(
    service.desktopStatus(user, "m-computer")
  ).resolves.toMatchObject({ connected: true, hostname: "box" });
  expect(asked).toEqual(["m-computer"]);
});

test("clipboardRead and clipboardWrite act as the caller and return the relay's outcome", async () => {
  seedMachine("m-computer", { computerStatus: "online" });
  const gets: [string, unknown][] = [];
  const sets: [string, unknown, unknown][] = [];
  const outcome = { ok: true, resultJson: "{}" } as const;
  relay = {
    ...relay,
    clipboardGet: (machineId, principal) => {
      gets.push([machineId, principal]);
      return Promise.resolve(outcome);
    },
    clipboardSet: (machineId, principal, input) => {
      sets.push([machineId, principal, input]);
      return Promise.resolve(outcome);
    },
  };
  service = build();

  await expect(service.clipboardRead(user, "m-computer")).resolves.toEqual(
    outcome
  );
  await expect(
    service.clipboardWrite(user, "m-computer", "hello")
  ).resolves.toEqual(outcome);
  expect(gets).toEqual([["m-computer", { kind: "human", userId: "u1" }]]);
  expect(sets).toEqual([
    [
      "m-computer",
      { kind: "human", userId: "u1" },
      { selections: ["clipboard", "primary"], text: "hello" },
    ],
  ]);
});

test("concurrent both-role enrol has one winner with a shared hash and revoke ends both roles", async () => {
  const { code } = await service.createEnrollToken(user, {
    machineName: "Office box",
    role: "both",
  });
  const input = {
    arch: "amd64" as const,
    clientVersion: "0.1.0",
    code,
    hostname: "box",
    os: "linux" as const,
    roles: ["computer", "agent_host"] as ("computer" | "agent_host")[],
    singleUser: false,
  };
  const results = await Promise.all([
    service.enroll(input),
    service.enroll(input),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const enrolled = results.find((result) => result !== null);
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  const hash = await hashToken(enrolled.credential);
  expect(db.select().from(machines).all()).toHaveLength(1);
  expect(machineRow(enrolled.machineId)).toMatchObject({
    computerStatus: "offline",
    credentialHash: hash,
    name: "Office box",
    singleUser: false,
    status: "offline",
  });
  expect(db.select().from(machineCredentials).all()).toMatchObject([
    { credentialHash: hash, machineId: enrolled.machineId, role: "computer" },
  ]);
  const authorization = `Bearer ${enrolled.credential}`;
  expect(await service.authenticate(authorization)).toEqual({
    kind: "machine",
    machineId: enrolled.machineId,
    workspaceId: WORKSPACE,
  });
  expect(await service.authenticate(authorization, "computer")).toEqual({
    kind: "machine",
    machineId: enrolled.machineId,
    workspaceId: WORKSPACE,
  });
  await service.revoke(user, enrolled.machineId);
  expect(await service.authenticate(authorization)).toBeNull();
  expect(await service.authenticate(authorization, "computer")).toBeNull();
});
