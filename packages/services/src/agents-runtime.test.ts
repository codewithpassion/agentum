import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import {
  managedSessions,
  workspaceAnthropicKeys,
} from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const NOW = "2026-01-01T00:00:00.000Z";
const OWNER = "u1";
const user: Principal = {
  kind: "user",
  userId: OWNER,
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createAgentsService>;
let events: ReturnType<typeof createEventsService>;
let dropped: string[];

const insertMachine = (id: string, credentialHash = `hash-${id}`) =>
  db
    .insert(machines)
    .values({
      capabilities: "{}",
      createdAt: NOW,
      credentialHash,
      enrolledBy: OWNER,
      id,
      name: id,
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();

const insertKey = () =>
  db
    .insert(workspaceAnthropicKeys)
    .values({
      apiKeyEnc: "enc",
      createdAt: NOW,
      keyHint: "ANTH",
      setBy: OWNER,
      updatedAt: NOW,
      workspaceId: WORKSPACE,
    })
    .run();

const insertSession = (agentId: string, id = "ses1") =>
  db
    .insert(sessions)
    .values({
      actorId: OWNER,
      actorKind: "user",
      agentId,
      createdAt: NOW,
      id,
      origin: "ui",
      runtimeMachineId: null,
      runtimeRef: "claude-session-1",
      workspaceId: WORKSPACE,
    })
    .run();

const insertRun = (agentId: string, status: "done" | "waiting", id = "run1") =>
  db
    .insert(runs)
    .values({
      actorId: OWNER,
      actorKind: "user",
      agentId,
      createdAt: NOW,
      id,
      inputText: "",
      sessionId: "ses1",
      status,
      workspaceId: WORKSPACE,
    })
    .run();

const insertManagedSession = (sessionId = "ses1") =>
  db
    .insert(managedSessions)
    .values({
      agentFingerprint: "fp",
      anthropicSessionId: "sesn_1",
      createdAt: NOW,
      sessionId,
      tokenIssuedAt: 1,
      vaultId: "vlt_1",
      workspaceId: WORKSPACE,
    })
    .run();

const sessionRow = () =>
  db.select().from(sessions).where(eq(sessions.id, "ses1")).get();

beforeEach(() => {
  db = migrated();
  dropped = [];
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
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
  service = createAgentsService({
    atomic: sqliteAtomic(db),
    db,
    dropVaults: (_workspaceId, vaultIds) => {
      dropped.push(...vaultIds);
      return Promise.resolve();
    },
    events,
  });
});

const createCloud = (runtimeConfig = {}) =>
  service.create(user, {
    model: "claude-sonnet-5-5",
    name: "Digest",
    runtime: "cloud",
    runtimeConfig,
  });

test("cloud to managed keeps the model, drops cloud-only keys and clears the runtime ref", async () => {
  insertKey();
  const agent = await createCloud({
    environment: "isolate",
    networkAccess: true,
  });
  insertSession(agent.id);
  const moved = await service.changeRuntime(user, agent.id, {
    runtime: "managed",
  });
  expect(moved).toMatchObject({ machineId: null, runtime: "managed" });
  expect(moved.runtimeConfig).toEqual({});
  expect(sessionRow()).toMatchObject({
    runtimeMachineId: null,
    runtimeRef: null,
  });
  const [event] = await events.query(user, WORKSPACE, {
    agentId: agent.id,
    types: ["agent.updated"],
  });
  expect(event?.payload).toMatchObject({
    changed: ["runtime"],
    from: "cloud",
    to: "managed",
  });
});

test("managed back to cloud closes its sessions and drops their vaults", async () => {
  insertKey();
  const agent = await createCloud();
  await service.changeRuntime(user, agent.id, { runtime: "managed" });
  insertSession(agent.id);
  insertManagedSession();
  const moved = await service.changeRuntime(user, agent.id, {
    runtime: "cloud",
  });
  expect(moved.runtime).toBe("cloud");
  const [managed] = db.select().from(managedSessions).all();
  expect(managed?.closedAt).not.toBeNull();
  expect(dropped).toEqual(["vlt_1"]);
});

test("moving to a machine sets the machine, clears the runtime ref and detaches the computer", async () => {
  insertMachine("m-host");
  insertMachine("m-comp");
  const agent = await createCloud();
  insertSession(agent.id);
  db.update(agents)
    .set({ computerMachineId: "m-comp" })
    .where(eq(agents.id, agent.id))
    .run();
  const moved = await service.changeRuntime(user, agent.id, {
    machineId: "m-host",
    model: "claude-haiku-5-5",
    runtime: "machine",
  });
  expect(moved).toMatchObject({
    computerMachineId: null,
    machineId: "m-host",
    model: "claude-haiku-5-5",
    runtime: "machine",
  });
  expect(sessionRow()?.runtimeRef).toBeNull();
});

test("machine to cloud clears the machine", async () => {
  insertMachine("m-host");
  const agent = await service.create(user, {
    machineId: "m-host",
    model: "claude-sonnet-5-5",
    name: "Box",
    runtime: "machine",
  });
  const moved = await service.changeRuntime(user, agent.id, {
    runtime: "cloud",
  });
  expect(moved).toMatchObject({ machineId: null, runtime: "cloud" });
});

test("machine to managed drops the machine and the turn limit managed cannot take", async () => {
  insertMachine("m-host");
  insertKey();
  const agent = await service.create(user, {
    machineId: "m-host",
    model: "claude-sonnet-5-5",
    name: "Box",
    runtime: "machine",
    runtimeConfig: { maxTurns: 10 },
  });
  const moved = await service.changeRuntime(user, agent.id, {
    runtime: "managed",
  });
  expect(moved).toMatchObject({ machineId: null, runtime: "managed" });
  expect(moved.runtimeConfig).toEqual({});
});

test("a live run blocks the move and the refusal names it", async () => {
  insertKey();
  const agent = await createCloud();
  insertSession(agent.id);
  insertRun(agent.id, "waiting", "run-live");
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "managed" })
  ).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining("run-live"),
  });
  expect((await service.get(user, agent.id)).runtime).toBe("cloud");
  expect(sessionRow()?.runtimeRef).toBe("claude-session-1");
});

test("a finished run does not block the move", async () => {
  insertKey();
  const agent = await createCloud();
  insertSession(agent.id);
  insertRun(agent.id, "done");
  expect(
    (await service.changeRuntime(user, agent.id, { runtime: "managed" }))
      .runtime
  ).toBe("managed");
});

test("managed needs the Anthropic key", async () => {
  const agent = await createCloud();
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "managed" })
  ).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("Anthropic API key"),
  });
});

test("managed and machine need an Anthropic model", async () => {
  insertKey();
  const agent = await service.create(user, {
    model: "openrouter:z-ai/glm-5.3",
    name: "Other",
    runtime: "cloud",
  });
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "managed" })
  ).rejects.toMatchObject({ code: "invalid" });
  expect(
    (
      await service.changeRuntime(user, agent.id, {
        model: "claude-sonnet-5-5",
        runtime: "managed",
      })
    ).model
  ).toBe("claude-sonnet-5-5");
});

test("machine needs a machine in the workspace with the agent_host role", async () => {
  insertMachine("m-comp", "computer-only:abc");
  const agent = await createCloud();
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "machine" })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.changeRuntime(user, agent.id, {
      machineId: "missing",
      runtime: "machine",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.changeRuntime(user, agent.id, {
      machineId: "m-comp",
      runtime: "machine",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  expect((await service.get(user, agent.id)).runtime).toBe("cloud");
});

test("only a machine target takes a machineId", async () => {
  insertMachine("m-host");
  const agent = await createCloud();
  await expect(
    service.changeRuntime(user, agent.id, {
      machineId: "m-host",
      runtime: "managed",
    })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("moving to the runtime the agent already has is refused", async () => {
  const agent = await createCloud();
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "cloud" })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("only the owner or an admin on a browser session may move an agent", async () => {
  insertKey();
  const agent = await createCloud();
  const member: Principal = { ...user, userId: "u-member" };
  await expect(
    service.changeRuntime(member, agent.id, { runtime: "managed" })
  ).rejects.toThrow(ForbiddenError);
  await expect(
    service.changeRuntime({ ...user, via: "api_key" }, agent.id, {
      runtime: "managed",
    })
  ).rejects.toThrow(ForbiddenError);
  expect(
    (
      await service.changeRuntime({ ...member, isAdmin: true }, agent.id, {
        runtime: "managed",
      })
    ).runtime
  ).toBe("managed");
});

test("managed to a machine closes its sessions and detaches the computer", async () => {
  insertKey();
  insertMachine("m-host");
  insertMachine("m-comp");
  const agent = await createCloud();
  await service.changeRuntime(user, agent.id, { runtime: "managed" });
  insertSession(agent.id);
  insertManagedSession();
  db.update(agents)
    .set({ computerMachineId: "m-comp" })
    .where(eq(agents.id, agent.id))
    .run();
  const moved = await service.changeRuntime(user, agent.id, {
    machineId: "m-host",
    runtime: "machine",
  });
  expect(moved).toMatchObject({
    computerMachineId: null,
    machineId: "m-host",
    runtime: "machine",
  });
  expect(db.select().from(managedSessions).get()?.closedAt).not.toBeNull();
  expect(dropped).toEqual(["vlt_1"]);
});

test("a machine agent moves to another machine", async () => {
  insertMachine("m-a");
  insertMachine("m-b");
  const agent = await service.create(user, {
    machineId: "m-a",
    model: "claude-sonnet-5-5",
    name: "Box",
    runtime: "machine",
  });
  insertSession(agent.id);
  const moved = await service.changeRuntime(user, agent.id, {
    machineId: "m-b",
    runtime: "machine",
  });
  expect(moved.machineId).toBe("m-b");
  expect(sessionRow()?.runtimeRef).toBeNull();
});

test("only an active agent can be moved", async () => {
  const agent = await createCloud();
  await service.archive(user, agent.id);
  await expect(
    service.changeRuntime(user, agent.id, { runtime: "managed" })
  ).rejects.toMatchObject({ code: "invalid" });
});
