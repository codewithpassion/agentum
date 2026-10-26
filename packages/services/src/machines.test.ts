import { beforeEach, expect, test } from "bun:test";
import { machineEnrollTokens, machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import type { RunStatus } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService, type EventsService } from "./events.ts";
import type { MachineRelayPort } from "./machines/types.ts";
import {
  createMachinesService,
  ENROLL_TOKEN_PREFIX,
  MACHINE_CREDENTIAL_PREFIX,
} from "./machines.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const ORG = `org_${WORKSPACE}`;
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
    name = id,
    status = "offline",
    workspaceId = WORKSPACE,
  }: {
    capabilities?: string;
    name?: string;
    status?: "offline" | "online" | "revoked";
    workspaceId?: string;
  } = {}
) =>
  db
    .insert(machines)
    .values({
      capabilities,
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

const eventsOf = (type: "machine.online" | "machine.offline") =>
  events.query(system, WORKSPACE, { types: [type] });

/** Builds the service, with `allowedOrgIds` overridable for the org check. */
const build = (allowedOrgIds: string[] = [ORG]): Service =>
  createMachinesService({ allowedOrgIds, clock, db, events, relay });

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

test("authenticate accepts only a live machine credential in an allowed workspace", async () => {
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
  expect(
    await build(["org_other"]).authenticate(`Bearer ${enrolled.credential}`)
  ).toBeNull();

  await service.revoke(user, enrolled.machineId);
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
