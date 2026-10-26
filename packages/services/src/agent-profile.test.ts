import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { connectors as connectorRows } from "@repo/db/schema/connectors";
import { agentLibraryAccess } from "@repo/db/schema/library";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces } from "@repo/db/schema/workspaces";
import type { RunStatus } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { createAgentProfileService } from "./agent-profile.ts";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { seedAssignment, seedConnector } from "./connectors/test-seed.ts";
import { createConnectorsService } from "./connectors.ts";
import { createEventsService } from "./events.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { noopRelay } from "./machines/types.ts";
import { createMachinesService } from "./machines.ts";
import { createRequestsService } from "./requests.ts";
import { createRoutinesService } from "./routines.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { createSecretsService } from "./secrets.ts";
import { memorySkillBlobs } from "./skills-store/memory.ts";
import { skillMd } from "./skills-store/test-support.ts";
import { createSkillsStoreService } from "./skills-store.ts";
import { createSlackAppsService } from "./slack-apps.ts";
import { createTasksService } from "./tasks/service.ts";
import { createTriggersService } from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

const NOW = "2026-10-26T09:00:00.000Z";
const SECRETS_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32))
).toString("base64");

const user = (workspaceId = "w1"): Principal => ({
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId,
});

let db: ReturnType<typeof migrated>;
let agents: AgentsService;
let secrets: ReturnType<typeof createSecretsService>;
let skillsStore: ReturnType<typeof createSkillsStoreService>;
let triggers: ReturnType<typeof createTriggersService>;
let routines: ReturnType<typeof createRoutinesService>;
let requests: ReturnType<typeof createRequestsService>;
let service: ReturnType<typeof createAgentProfileService>;
let a1: string;
let a2: string;
let a3: string;
let b1: string;
let counter: number;

beforeEach(async () => {
  db = migrated();
  counter = 0;
  await db.insert(workspaces).values(
    ["w1", "w2"].map((id) => ({
      clerkOrgId: `org_${id}`,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const atomic = sqliteAtomic(db);
  const events = createEventsService({ blobs, db });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: () => Promise.resolve(),
  };
  const runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: {
      maskerFor: () => Promise.resolve(createMasker({ NAME: "value-12345" })),
    },
  });
  agents = createAgentsService({ db, events });
  const connectors = createConnectorsService({
    atomic,
    clock,
    db,
    events,
    fetch: () => Promise.reject(new Error("no network in this test")),
  });
  secrets = createSecretsService({
    atomic,
    clock,
    db,
    events,
    secretsKey: SECRETS_KEY,
  });
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  skillsStore = createSkillsStoreService({
    atomic,
    blobs: memorySkillBlobs(),
    clock,
    db,
    events,
    library,
  });
  triggers = createTriggersService({
    allowedOrgIds: ["org_w1", "org_w2"],
    clock,
    db,
    events,
    runs,
  });
  routines = createRoutinesService({
    allowedOrgIds: ["org_w1", "org_w2"],
    clock,
    db,
    events,
    runs,
  });
  service = createAgentProfileService({
    agents,
    connectors,
    db,
    machines: createMachinesService({
      allowedOrgIds: ["org_w1", "org_w2"],
      atomic,
      clock,
      db,
      events,
      relay: noopRelay,
    }),
    requests,
    routines,
    secrets,
    skillsStore,
    slackApps: createSlackAppsService({
      atomic,
      clock,
      db,
      events,
      fetch: () => Promise.reject(new Error("no network in this test")),
      publicBaseUrl: "https://hm.example.com",
      secretsKey: SECRETS_KEY,
    }),
    tasks: createTasksService({
      clock,
      db,
      events,
      eventTypes: [],
      requests,
    }),
    triggers,
  });
  const make = async (name: string, workspaceId: string) =>
    (
      await agents.create(user(workspaceId), {
        model: "m",
        name,
        runtime: "cloud",
      })
    ).id;
  a1 = await make("Alpha", "w1");
  a2 = await make("Beta", "w1");
  a3 = await make("Gamma", "w1");
  b1 = await make("Other", "w2");
});

const seedRun = async (
  agentId: string,
  status: RunStatus,
  workspaceId = "w1"
) => {
  counter += 1;
  const id = `run${String(counter).padStart(3, "0")}`;
  await db.insert(sessions).values({
    actorId: "u1",
    actorKind: "user",
    agentId,
    createdAt: NOW,
    id: `s-${id}`,
    origin: "mcp",
    private: false,
    workspaceId,
  });
  await db.insert(runRows).values({
    actorId: "u1",
    actorKind: "user",
    agentId,
    createdAt: NOW,
    id,
    inputText: `Task ${id}`,
    sessionId: `s-${id}`,
    status,
    workspaceId,
  });
  return id;
};

const tool = (name: string, readOnly: boolean) => ({
  description: null,
  name,
  readOnly,
});

/** A connector in w1 with its tools and an assignment to `agentId`. */
const connect = async (
  id: string,
  name: string,
  tools: ReturnType<typeof tool>[],
  agentId = a1,
  allowedTools: string[] | null = null
) => {
  await seedConnector(db, {
    authKind: "header",
    headerName: "X-Key",
    id,
    name,
    now: NOW,
    workspaceId: "w1",
  });
  await db
    .update(connectorRows)
    .set({ tools: JSON.stringify(tools) })
    .where(eq(connectorRows.id, id));
  await seedAssignment(db, {
    agentId,
    allowedTools,
    connectorId: id,
    now: `2026-10-26T09:00:0${counter}.000Z`,
    workspaceId: "w1",
  });
  counter += 1;
};

test("profile fills every row from seeded data", async () => {
  await db.insert(machines).values({
    capabilities: "{}",
    createdAt: NOW,
    credentialHash: "hash",
    enrolledBy: "u1",
    id: "m1",
    lastSeenAt: null,
    name: "Studio Mac",
    singleUser: false,
    status: "online",
    workspaceId: "w1",
  });
  await db
    .update(agentRows)
    .set({
      emailLocal: "alpha",
      handsTo: JSON.stringify([a2]),
      instructions: "Triage the inbox.",
      machineId: "m1",
      runtimeConfig: JSON.stringify({ libraryPaths: ["shared/notes", "docs"] }),
      soul: "Warm and brief.",
    })
    .where(eq(agentRows.id, a1));
  await db.insert(agentLibraryAccess).values([
    {
      agentId: a1,
      createdAt: NOW,
      mode: "read",
      path: "shared/notes",
      workspaceId: "w1",
    },
    {
      agentId: a1,
      createdAt: NOW,
      mode: "write",
      path: "docs",
      workspaceId: "w1",
    },
  ]);
  await connect("c1", "Xero", [
    tool("create_bill", false),
    tool("list_bills", true),
  ]);
  const secret = await secrets.create(user(), {
    mode: "env",
    name: "XERO_TENANT",
    value: "tenant-value-123",
  });
  await secrets.setGrants(user(), a1, [secret.id]);
  const skill = await skillsStore.create(user(), {
    files: [{ content: skillMd("triage"), path: "SKILL.md" }],
    message: "First",
    name: "triage",
  });
  await skillsStore.assign(user(), { agentId: a1, skillId: skill.skill.id });
  const trigger = await triggers.create(user(), {
    agentId: a1,
    name: "Webhook",
  });
  const routine = await routines.create(user(), {
    agentId: a1,
    cron: "0 9 * * *",
    name: "Morning",
    prompt: "Check the inbox",
  });
  await db.insert(slackApps).values({
    agentId: a1,
    appId: "A1",
    botUserId: "U1",
    createdAt: NOW,
    id: "sa1",
    listenMode: "mentions",
    signingSecret: "x",
    status: "installed",
    teamId: "T1",
    workspaceId: "w1",
  });
  const waiting = await seedRun(a1, "waiting");
  const done = await seedRun(a1, "done");

  const profile = await service.profile(user(), { agentId: a1 });

  expect(profile.header).toMatchObject({
    emailLocal: "alpha",
    id: a1,
    machine: { id: "m1", name: "Studio Mac", status: "online" },
    model: "m",
    name: "Alpha",
    runtime: "cloud",
    slug: "alpha",
    status: "active",
    waitingRun: { runId: waiting, sessionId: `s-${waiting}` },
  });
  expect(profile.does).toBe("Triage the inbox.");
  expect(profile.voice).toBe("Warm and brief.");
  expect(profile.tools.connectors).toEqual([
    {
      allowedTools: null,
      connectorId: "c1",
      name: "Xero",
      status: "ok",
      toolCount: 2,
    },
  ]);
  expect(profile.tools.secrets).toEqual([
    { id: secret.id, mode: "env", name: "XERO_TENANT" },
  ]);
  expect(profile.skills).toEqual([
    {
      name: "triage",
      pinnedVersion: null,
      proposedVersion: null,
      skillId: skill.skill.id,
    },
  ]);
  expect(profile.handsTo).toEqual([{ id: a2, name: "Beta", slug: "beta" }]);
  expect(profile.receivesFrom).toEqual([]);
  expect(profile.startsOn.triggers.map((row) => row.id)).toEqual([
    trigger.trigger.id,
  ]);
  expect(profile.startsOn.routines).toMatchObject([
    { cron: "0 9 * * *", id: routine.id, name: "Morning", paused: false },
  ]);
  expect(profile.startsOn.slackMention).toEqual({
    id: "sa1",
    listenMode: "mentions",
    status: "installed",
  });
  expect(profile.channels).toEqual({
    email: "reserved",
    slack: { id: "sa1", listenMode: "mentions", status: "installed" },
  });
  expect(profile.library.folders).toEqual([
    { access: "write", home: true, path: "agents/alpha" },
    { access: "read", home: false, path: "wiki" },
    { access: "write", home: false, path: "docs" },
    { access: "read", home: false, path: "shared/notes" },
  ]);
  expect(profile.recentTasks.map((task) => task.id)).toEqual([done, waiting]);
});

test("a proposed skill version shows next to the skill", async () => {
  const runId = await seedRun(a1, "running");
  // A run's new skill is owned by its agent and starts as a proposal.
  const skill = await skillsStore.create(
    { agentId: a1, kind: "run", runId, workspaceId: "w1" },
    {
      files: [{ content: skillMd("triage"), path: "SKILL.md" }],
      message: "First",
      name: "triage",
    }
  );
  await skillsStore.assign(user(), { agentId: a1, skillId: skill.skill.id });

  const { skills } = await service.profile(user(), { agentId: a1 });

  expect(skills).toMatchObject([{ name: "triage", proposedVersion: 1 }]);
});

test("Receives from inverts hands_to", async () => {
  await db
    .update(agentRows)
    .set({ handsTo: JSON.stringify([a3]) })
    .where(eq(agentRows.id, a1));
  await db
    .update(agentRows)
    .set({ handsTo: JSON.stringify([a3, a1]) })
    .where(eq(agentRows.id, a2));

  const gamma = await service.profile(user(), { agentId: a3 });
  const alpha = await service.profile(user(), { agentId: a1 });

  expect(gamma.receivesFrom.map((ref) => ref.id)).toEqual([a1, a2]);
  expect(gamma.handsTo).toEqual([]);
  expect(alpha.receivesFrom.map((ref) => ref.id)).toEqual([a2]);
  expect(alpha.handsTo.map((ref) => ref.id)).toEqual([a3]);
});

test("an archived agent is missing from Hands to and Receives from", async () => {
  await db
    .update(agentRows)
    .set({ handsTo: JSON.stringify([a2, a3]) })
    .where(eq(agentRows.id, a1));
  await db
    .update(agentRows)
    .set({ handsTo: JSON.stringify([a1]) })
    .where(eq(agentRows.id, a2));
  await db
    .update(agentRows)
    .set({ status: "archived" })
    .where(eq(agentRows.id, a2));

  const alpha = await service.profile(user(), { agentId: a1 });

  expect(alpha.handsTo.map((ref) => ref.id)).toEqual([a3]);
  expect(alpha.receivesFrom).toEqual([]);
});

test("a draft agent is not found by any method", async () => {
  await db
    .update(agentRows)
    .set({ status: "draft" })
    .where(eq(agentRows.id, a1));

  const codes = await Promise.all([
    service.profile(user(), { agentId: a1 }).catch((error: unknown) => error),
    service.askBefore(user(), { agentId: a1 }).catch((error: unknown) => error),
    service
      .setAskBefore(user(), { action: "bash", agentId: a1, ask: true })
      .catch((error: unknown) => error),
  ]);

  for (const error of codes) {
    expect(error).toMatchObject({ code: "not_found" });
  }
});

test("askBefore lists the built-ins and the connector tools that change things", async () => {
  await connect(
    "c1",
    "Xero",
    [
      tool("create_bill", false),
      tool("list_bills", true),
      tool("void_bill", false),
    ],
    a1,
    ["create_bill", "list_bills"]
  );
  await connect("c2", "Xero", [tool("send-invoice", false)]);

  const actions = await service.askBefore(user(), { agentId: a1 });

  expect(actions.map((row) => row.action)).toEqual([
    "bash",
    "write",
    "edit",
    "web_fetch",
    "run_script",
    "run_skill_script",
    "xero/create_bill",
    "xero-2/send-invoice",
  ]);
  expect(actions.find((row) => row.action === "xero/create_bill")).toEqual({
    action: "xero/create_bill",
    ask: false,
    kind: "connector",
    label: "Xero: create bill",
  });
  expect(
    actions.find((row) => row.action === "xero-2/send-invoice")?.label
  ).toBe("Xero: send invoice");
  expect(actions.every((row) => row.ask === false)).toBe(true);
  expect(actions.find((row) => row.action === "bash")?.covers).toBe(
    "Also the library script shell and the computer shell."
  );
  expect(actions.find((row) => row.action === "write")?.covers).toBe(
    "Also writing library files, and the library script shell, since a script there can write files."
  );
  expect(actions.find((row) => row.action === "edit")?.covers).toBe(
    "Also editing a file on the computer."
  );
  expect(
    actions.find((row) => row.action === "xero/create_bill")
  ).not.toHaveProperty("covers");
});

test("toggling ask before round-trips through V1's rules", async () => {
  await db.insert(agentLibraryAccess).values([
    {
      agentId: a1,
      createdAt: NOW,
      mode: "read",
      path: "shared/notes",
      workspaceId: "w1",
    },
    {
      agentId: a1,
      createdAt: NOW,
      mode: "write",
      path: "docs",
      workspaceId: "w1",
    },
  ]);
  await connect("c1", "Xero", [tool("create_bill", false)]);
  const asking = async () =>
    (await service.askBefore(user(), { agentId: a1 }))
      .filter((row) => row.ask)
      .map((row) => row.action);

  await service.setAskBefore(user(), {
    action: "xero/create_bill",
    agentId: a1,
    ask: true,
  });
  await service.setAskBefore(user(), {
    action: "bash",
    agentId: a1,
    ask: true,
  });

  expect(await asking()).toEqual(["bash", "xero/create_bill"]);
  expect(
    (await requests.listRules(user(), { agentId: a1 })).map((rule) => [
      rule.toolKey,
      rule.mode,
    ])
  ).toEqual([
    ["bash", "ask"],
    ["xero/create_bill", "ask"],
  ]);

  await service.setAskBefore(user(), {
    action: "bash",
    agentId: a1,
    ask: false,
  });

  expect(await asking()).toEqual(["xero/create_bill"]);
  expect(await requests.listRules(user(), { agentId: a1 })).toHaveLength(1);
});

test("a rule in mode allow shows as off, and turning it off removes it", async () => {
  await requests.setRule(user(), {
    agentId: a1,
    mode: "allow",
    toolKey: "bash",
  });

  const before = await service.askBefore(user(), { agentId: a1 });
  expect(before.find((row) => row.action === "bash")?.ask).toBe(false);

  await service.setAskBefore(user(), {
    action: "bash",
    agentId: a1,
    ask: false,
  });

  expect(await requests.listRules(user(), { agentId: a1 })).toEqual([]);
});

test("turning a switch on clears an Always allow on the platform tools it covers", async () => {
  await requests.setRule(user(), {
    agentId: a1,
    mode: "allow",
    toolKey: "harbourmaster/bash",
  });
  await requests.setRule(user(), {
    agentId: a1,
    mode: "allow",
    toolKey: "harbourmaster/library_read",
  });

  await service.setAskBefore(user(), {
    action: "bash",
    agentId: a1,
    ask: true,
  });

  const rules = await requests.listRules(user(), { agentId: a1 });
  expect(rules.map((rule) => `${rule.toolKey}:${rule.mode}`).sort()).toEqual([
    "bash:ask",
    "harbourmaster/library_read:allow",
  ]);
});

test("a revoked trigger is left out of Starts on", async () => {
  const live = await triggers.create(user(), { agentId: a1, name: "Live" });
  const revoked = await triggers.create(user(), {
    agentId: a1,
    name: "Revoked",
  });
  await triggers.revoke(user(), revoked.trigger.id);

  const { startsOn } = await service.profile(user(), { agentId: a1 });

  expect(startsOn.triggers.map((row) => row.id)).toEqual([live.trigger.id]);
});

test("two workspaces never see each other's agents or data", async () => {
  await db.insert(agentLibraryAccess).values([
    {
      agentId: a1,
      createdAt: NOW,
      mode: "read",
      path: "shared/notes",
      workspaceId: "w1",
    },
    {
      agentId: a1,
      createdAt: NOW,
      mode: "write",
      path: "docs",
      workspaceId: "w1",
    },
  ]);
  await connect("c1", "Xero", [tool("create_bill", false)]);
  await seedRun(a1, "waiting");

  const other = await service.profile(user("w2"), { agentId: b1 });
  expect(other.header.id).toBe(b1);
  expect(other.tools.connectors).toEqual([]);
  expect(other.header.waitingRun).toBeNull();
  expect(other.recentTasks).toEqual([]);

  const refusals = await Promise.all(
    [
      () => service.profile(user("w2"), { agentId: a1 }),
      () => service.askBefore(user("w2"), { agentId: a1 }),
      () =>
        service.setAskBefore(user("w2"), {
          action: "bash",
          agentId: a1,
          ask: true,
        }),
      () => service.profile(user("w1"), { agentId: b1 }),
    ].map((call) => call().catch((error: unknown) => error))
  );
  for (const error of refusals) {
    expect(error).toMatchObject({ code: "not_found" });
  }
  expect(await requests.listRules(user(), { agentId: a1 })).toEqual([]);
});

test("only a signed-in person may read or write a profile", async () => {
  const run: Principal = {
    agentId: a1,
    kind: "run",
    runId: "r1",
    workspaceId: "w1",
  };

  await expect(service.profile(run, { agentId: a1 })).rejects.toBeInstanceOf(
    ForbiddenError
  );
  await expect(
    service.setAskBefore(run, { action: "bash", agentId: a1, ask: true })
  ).rejects.toBeInstanceOf(ForbiddenError);
});
