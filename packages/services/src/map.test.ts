import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { mapPositions } from "@repo/db/schema/map";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMapService } from "./map.ts";
import type { RequestRecord } from "./requests.ts";
import type { Principal } from "./workspaces.ts";

import { sqliteAtomic } from "@repo/db/atomic";
import { connectors as connectorRows } from "@repo/db/schema/connectors";
import { machines as machineRows } from "@repo/db/schema/machines";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createConnectorsService } from "./connectors.ts";
import { createEventsService } from "./events.ts";
import { createLibraryService } from "./library.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createMachinesService } from "./machines.ts";
import type { MachineRelayPort } from "./machines/types.ts";
import { createRoutinesService } from "./routines.ts";
import type { RunsService } from "./runs.ts";
import { createSkillsStoreService } from "./skills-store.ts";
import { memorySkillBlobs } from "./skills-store/memory.ts";
import { createTriggersService } from "./triggers.ts";

const now = "2026-10-27T12:00:00.000Z";
const edge = "2026-10-20T12:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
};
let db: ReturnType<typeof migrated>;
let pending: RequestRecord[];
const graph = () => editor().map.graph(user, { days: 7 });
let seq = 0;
const event = async (type: string, agentId = "a", payload = {}, extra = {}) => {
  seq += 1;
  await db.insert(events).values({
    actorId: "t",
    actorKind: "trigger",
    agentId,
    createdAt: now,
    id: `e${seq}`,
    payload: JSON.stringify(payload),
    type,
    workspaceId: "w",
    ...extra,
  });
};
beforeEach(async () => {
  db = migrated();
  pending = [];
  seq = 0;
  await db.insert(workspaces).values(
    ["w", "other"].map((id) => ({
      clerkOrgId: id,
      createdAt: now,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  await db.insert(agents).values(
    ["a", "b", "foreign", "draft", "archived"].map((id) => ({
      createdAt: now,
      createdBy: "u",
      handsTo: id === "a" ? '["b"]' : "[]",
      id,
      instructions: "",
      model: "m",
      name: id,
      runtime: "fake" as const,
      runtimeConfig: id === "b" ? '{"browser":false}' : "{}",
      slug: id,
      status: ["draft", "archived"].includes(id) ? id : "active",
      workspaceId: id === "foreign" ? "other" : "w",
    }))
  );
  await db.insert(triggers).values(
    ["t", "idle", "revoked"].map((id) => ({
      agentId: "a",
      createdAt: now,
      createdBy: "u",
      id,
      kind: "http" as const,
      name: id,
      revokedAt: id === "revoked" ? now : null,
      workspaceId: "w",
    }))
  );
  await db.insert(sessions).values({
    actorId: "u",
    actorKind: "user",
    agentId: "a",
    createdAt: now,
    id: "s",
    origin: "inbox",
    workspaceId: "w",
  });
  await db.insert(runs).values(
    [
      { agentId: "a", id: "parent" },
      { agentId: "b", id: "child", parentRunId: "parent" },
      { agentId: "a", dryRun: true, id: "dry" },
    ].map((r) => ({
      ...r,
      actorId: "u",
      actorKind: "user",
      createdAt: now,
      inputText: "",
      sessionId: "s",
      status: "waiting" as const,
      workspaceId: "w",
    }))
  );
});
test("counts every wire kind and combines Q&A events", async () => {
  await event("trigger.fired");
  await event("trigger.fired");
  await event("run.queued", "b", { origin: "inbox" }, { runId: "child" });
  await event("slack.message_sent", "a", { channel: "C1" });
  await event("library.write", "a", { path: "agents/a/tasks/child/result.md" });
  await event("library.write", "a", { path: "agents/a/notes.md" });
  await event("qa.asked");
  await event("qa.answered");
  await event("mail.sent");
  const result = await graph();
  expect(result.wires.map((w) => [String(w.kind), w.count7d]).sort()).toEqual(
    [
      ["trigger", 2],
      ["trigger", 0],
      ["handoff", 1],
      ["slack", 1],
      ["library", 2],
      ["qa", 2],
      ["email", 1],
    ].sort()
  );
  expect(result.nodes.map((n) => n.key)).toContain("out:library:agents/a");
});
test("inclusive seven day edge, idle wires, dry runs and workspace isolation", async () => {
  await event("trigger.fired", "a", {}, { createdAt: edge });
  await event(
    "trigger.fired",
    "a",
    {},
    { createdAt: "2026-10-20T11:59:59.999Z" }
  );
  await event("trigger.fired", "a", {}, { runId: "dry" });
  await event("trigger.fired", "foreign", {}, { workspaceId: "other" });
  const result = await graph();
  expect(result.wires.find((w) => w.from === "trigger:t")?.count7d).toBe(1);
  expect(result.wires.find((w) => w.from === "trigger:idle")).toMatchObject({
    active: false,
    count7d: 0,
  });
  expect(
    result.nodes.filter((n) => n.kind === "agent").map((n) => n.key)
  ).toEqual(["agent:a", "agent:b"]);
  expect(result.nodes.some((n) => n.key === "trigger:revoked")).toBe(false);
});
test("waiting record and saved positions win over deterministic columns", async () => {
  const { runRequests } = await import("@repo/db/schema/requests");
  const { requestRecord } = await import("./requests/records.ts");
  const [record] = await db
    .insert(runRequests)
    .values({
      agentId: "a",
      createdAt: now,
      display: JSON.stringify({ questions: [{ question: "Continue?" }] }),
      expiresAt: "2026-10-28T12:00:00.000Z",
      id: "request",
      kind: "question",
      runId: "parent",
      sessionId: "s",
      status: "pending",
      toolName: "ask_user",
      toolUseId: "tool",
      workspaceId: "w",
    })
    .returning();
  if (!record) {
    throw new Error("request fixture missing");
  }
  pending = [requestRecord(record)];
  await db.insert(mapPositions).values({
    nodeKey: "agent:a",
    updatedAt: now,
    workspaceId: "w",
    x: 123,
    y: 456,
  });
  const result = await graph();
  expect(result.nodes.find((n) => n.key === "agent:a")).toMatchObject({
    pendingRequest: pending[0],
    waiting: true,
    x: 123,
    y: 456,
  });
  expect(result.nodes.find((n) => n.key === "agent:b")?.ports).toEqual([]);
  expect(result.nodes.find((n) => n.key === "agent:a")?.ports).toContainEqual({
    id: "a",
    kind: "browser",
    label: "Browser",
  });
  expect(await graph()).toEqual(result);
  const [visible] = pending;
  if (!visible) {
    throw new Error("request fixture missing");
  }
  pending.unshift({ ...visible, id: "dry-request", runId: "dry" });
  expect(
    (await graph()).nodes.find((n) => n.key === "agent:a")?.pendingRequest
  ).toEqual(visible);
});

test("mail, routines and Slack trigger nodes use their own event sources", async () => {
  const { agentMailboxes } = await import("@repo/db/schema/mail");
  const { slackApps } = await import("@repo/db/schema/slack");
  await db.insert(agentMailboxes).values({
    address: "a@example.test",
    agentId: "a",
    createdAt: now,
    id: "mb",
    status: "active",
    workspaceId: "w",
  });
  await db.insert(triggers).values(
    ["mail", "routine"].map((kind) => ({
      agentId: "a",
      createdAt: now,
      createdBy: "u",
      id: kind,
      kind: kind as "mail" | "routine",
      name: kind,
      workspaceId: "w",
    }))
  );
  await db.insert(slackApps).values({
    agentId: "a",
    appId: "api",
    botUserId: "bot",
    createdAt: now,
    id: "app",
    signingSecret: "encrypted",
    status: "installed",
    teamId: "team",
    workspaceId: "w",
  });
  await event("mail.received");
  await event("run.queued", "a", { origin: "slack" }, { runId: "parent" });
  await event("trigger.fired", "a", {}, { actorId: "routine" });
  const result = await graph();
  expect(result.nodes.find((n) => n.key === "trigger:mail")?.label).toBe(
    "a@example.test"
  );
  for (const from of ["trigger:mail", "trigger:routine", "trigger:slack:app"]) {
    expect(result.wires.find((w) => w.from === from)).toMatchObject({
      count7d: 1,
      to: "agent:a",
    });
  }
});

test("workspace assignments provide connector, skill and computer ports", async () => {
  const { connectors, agentConnectors } = await import(
    "@repo/db/schema/connectors"
  );
  const { skills, skillAssignments } = await import("@repo/db/schema/skills");
  const { machines } = await import("@repo/db/schema/machines");
  const { eq } = await import("drizzle-orm");
  await db.insert(machines).values({
    capabilities: "{}",
    computerStatus: "online",
    createdAt: now,
    credentialHash: "hash",
    enrolledBy: "u",
    id: "computer",
    name: "Desktop",
    singleUser: false,
    status: "offline",
    workspaceId: "w",
  });
  await db
    .update(agents)
    .set({ computerMachineId: "computer" })
    .where(eq(agents.id, "a"));
  await db.insert(connectors).values({
    authKind: "none",
    createdAt: now,
    createdBy: "u",
    id: "c",
    name: "Tools",
    status: "ok",
    url: "https://example.test",
    workspaceId: "w",
  });
  await db.insert(agentConnectors).values({
    agentId: "a",
    connectorId: "c",
    createdAt: now,
    workspaceId: "w",
  });
  await db.insert(skills).values({
    createdAt: now,
    createdBy: "u",
    createdByKind: "user",
    id: "skill",
    name: "Research",
    updatedAt: now,
    workspaceId: "w",
  });
  await db.insert(skillAssignments).values({
    agentId: "a",
    createdAt: now,
    skillId: "skill",
    workspaceId: "w",
  });
  expect((await graph()).nodes.find((n) => n.key === "agent:a")?.ports).toEqual(
    [
      { id: "c", kind: "connector", label: "Tools" },
      { id: "skill", kind: "skill", label: "Research" },
      { id: "computer", kind: "computer", label: "Computer", status: "online" },
      { id: "a", kind: "browser", label: "Browser" },
    ]
  );
});

test("known output destinations remain idle outside the event window", async () => {
  const { slackThreads } = await import("@repo/db/schema/slack");
  const { libraryVersions } = await import("@repo/db/schema/library");
  await db.insert(slackThreads).values({
    agentId: "a",
    channelId: "old-channel",
    createdAt: edge,
    id: "thread",
    sessionId: "s",
    teamId: "team",
    threadTs: "1",
    workspaceId: "w",
  });
  await db.insert(libraryVersions).values({
    authorId: "a",
    authorKind: "agent",
    createdAt: edge,
    etag: "etag",
    id: "version",
    op: "write",
    path: "agents/a/tasks/parent/result.md",
    sha256: "sha",
    size: 1,
    version: 1,
    workspaceId: "w",
  });
  const result = await graph();
  for (const to of ["out:slack:old-channel", "out:library:agents/a"]) {
    expect(result.wires.find((w) => w.to === to)).toMatchObject({
      active: false,
      count7d: 0,
      from: "agent:a",
    });
  }
});

test("active wires follow live runs and dry runs cannot make an agent waiting", async () => {
  const { eq } = await import("drizzle-orm");
  await db.update(runs).set({ status: "running" }).where(eq(runs.id, "child"));
  await event("run.queued", "b", { origin: "inbox" }, { runId: "child" });
  await event(
    "trigger.fired",
    "a",
    {},
    { createdAt: "2026-10-27T12:00:00.001Z" }
  );
  const result = await graph();
  expect(result.wires.find((w) => w.kind === "handoff")).toMatchObject({
    active: true,
    count7d: 1,
  });
  expect(result.wires.find((w) => w.from === "trigger:t")?.count7d).toBe(0);
  await db.update(runs).set({ status: "done" }).where(eq(runs.id, "parent"));
  expect((await graph()).nodes.find((n) => n.key === "agent:a")?.waiting).toBe(
    false
  );
});

// Exercise the editor against the profile services and the real migrated database.
const editor = () => {
  const atomic = sqliteAtomic(db);
  const clock = { now: () => new Date(now), sleep: async () => undefined };
  const log = createEventsService({
    blobs: { get: async () => null, put: async () => undefined }, db,
  });
  const common = { atomic, clock, db, events: log };
  const library = createLibraryService({ ...common, blobs: memoryLibraryBlobs() });
  const profile = createAgentsService(common);
  const triggerService = createTriggersService({ ...common, allowedOrgIds: [], runs: {} as RunsService });
  const routines = createRoutinesService({ ...common, runs: {} as RunsService });
  const connectors = createConnectorsService({ ...common, fetch });
  const skillsStore = createSkillsStoreService({ ...common, library, blobs: memorySkillBlobs() });
  const machines = createMachinesService({ ...common, allowedOrgIds: [], relay: {} as MachineRelayPort });
  const map = createMapService({ ...common, agents: profile, triggers: triggerService, routines, connectors, skillsStore, machines, requests: { listPending: async () => pending } });
  return { map, profile, triggerService, connectors, skillsStore, machines };
};
const edited = () => db.select().from(events).all().filter((e) => e.type === "map.edited");

test("editor reassigns HTTP and routine wires, refuses proposals and foreign or owned wires", async () => {
  const { map, triggerService } = editor();
  await map.connectTrigger(user, "t", "b");
  expect(db.select().from(triggers).where(eq(triggers.id, "t")).get()?.agentId).toBe("b");
  await triggerService.reassign(user, "idle", "b");
  expect(db.select().from(triggers).where(eq(triggers.id, "idle")).get()?.agentId).toBe("b");
  await db.insert(triggers).values([
    { id: "routine", kind: "routine", workspaceId: "w", agentId: "a", name: "routine", createdBy: "u", createdAt: now },
    { id: "mail", kind: "mail", workspaceId: "w", agentId: "a", name: "mail", createdBy: "u", createdAt: now },
    { id: "foreign-t", kind: "http", workspaceId: "other", agentId: "foreign", name: "foreign", createdBy: "u", createdAt: now },
  ]);
  const proposal = await triggerService.create({ kind: "run", agentId: "a", runId: "parent", workspaceId: "w" }, { agentId: "a", name: "proposal" });
  await expect(map.connectTrigger(user, proposal.trigger.id, "b")).rejects.toThrow("approve it first");
  await expect(map.connectTrigger(user, "foreign-t", "b")).rejects.toThrow();
  await expect(map.connectTrigger(user, "t", "foreign")).rejects.toThrow();
  await expect(map.connectTrigger(user, "mail", "b")).rejects.toThrow();
  await expect(map.disconnectTrigger(user, "slack:app")).rejects.toThrow();
  await map.connectTrigger(user, "routine", "b");
  await map.disconnectTrigger(user, "routine");
  await map.disconnectTrigger(user, "t");
  expect(db.select().from(triggers).where(eq(triggers.id, "routine")).get()).toMatchObject({ agentId: "b", revokedAt: now });
  expect(db.select().from(triggers).where(eq(triggers.id, "t")).get()?.revokedAt).toBe(now);
  expect(db.select().from(triggers).where(eq(triggers.id, proposal.trigger.id)).get()).toMatchObject({ agentId: "a", approvedAt: null, tokenHash: null, disabledAt: now });
  expect(edited()).toHaveLength(4);
});

test("editor uses profile assignments and preserves other browser runtime config", async () => {
  const { map, profile, skillsStore } = editor();
  await db.insert(connectorRows).values({ id: "c", workspaceId: "w", name: "Tools", url: "https://example.test", authKind: "none", status: "ok", createdBy: "u", createdAt: now });
  const skill = await skillsStore.create(user, { name: "research", message: "initial", files: [{ path: "SKILL.md", content: "---\nname: research\ndescription: Research things\n---\nResearch." }] });
  for (const tool of [{ kind: "connector", id: "c" }, { kind: "skill", id: skill.skillId }] as const) {
    await map.plugTool(user, "a", tool);
    expect((await map.graph(user, { days: 7 })).nodes.find((n) => n.key === "agent:a")?.ports).toContainEqual(expect.objectContaining({ id: tool.id, kind: tool.kind }));
    await map.unplugTool(user, "a", tool);
    expect((await map.graph(user, { days: 7 })).nodes.find((n) => n.key === "agent:a")?.ports.some((p) => p.kind === tool.kind)).toBe(false);
  }
  await profile.update(user, "a", { runtimeConfig: { custom: "kept" } });
  await map.unplugTool(user, "a", { kind: "browser" });
  expect((await profile.get(user, "a")).runtimeConfig).toEqual({ custom: "kept", browser: false });
  await map.plugTool(user, "a", { kind: "browser" });
  expect((await profile.get(user, "a")).runtimeConfig).toEqual({ custom: "kept" });
  await expect(map.plugTool({ kind: "run", agentId: "a", runId: "parent", workspaceId: "w" }, "a", { kind: "connector", id: "c" })).rejects.toThrow();
  expect(edited()).toHaveLength(6);
});

test("computer editor preserves runtime, workspace and exclusive assignment rules", async () => {
  const { map } = editor();
  await db.insert(machineRows).values({ id: "pc", workspaceId: "w", name: "PC", credentialHash: "hash", capabilities: "{}", computerStatus: "online", status: "online", singleUser: false, enrolledBy: "u", createdAt: now });
  await db.update(agents).set({ runtime: "machine" }).where(eq(agents.id, "a"));
  await expect(map.plugTool(user, "a", { kind: "computer", id: "pc" })).rejects.toThrow();
  await db.update(agents).set({ runtime: "cloud" }).where(eq(agents.id, "a"));
  await db.update(agents).set({ runtime: "managed" }).where(eq(agents.id, "b"));
  await expect(map.plugTool(user, "foreign", { kind: "computer", id: "pc" })).rejects.toThrow();
  await map.plugTool(user, "a", { kind: "computer", id: "pc" });
  await expect(map.plugTool(user, "b", { kind: "computer", id: "pc" })).rejects.toThrow();
  await map.unplugTool(user, "a", { kind: "computer", id: "pc" });
  expect(db.select().from(agents).where(eq(agents.id, "a")).get()?.computerMachineId).toBeNull();
  expect(edited()).toHaveLength(2);
});

test("positions upsert in workspace, validate keys and cap before writing", async () => {
  const { map } = editor();
  await map.savePositions(user, [{ key: "agent:a", x: 1, y: 2 }]);
  await map.savePositions(user, [{ key: "agent:a", x: 3, y: 4 }, { key: "out:qa", x: -2, y: 0 }]);
  expect(db.select().from(mapPositions).all()).toHaveLength(2);
  expect(db.select().from(mapPositions).where(eq(mapPositions.nodeKey, "agent:a")).get()).toMatchObject({ x: 3, y: 4, workspaceId: "w" });
  for (const key of ["bad:a", "agent:", "out:qa:extra", "trigger:slack:", "out:library:"]) {
    await expect(map.savePositions(user, [{ key, x: 1, y: 2 }])).rejects.toThrow();
  }
  await expect(map.savePositions(user, Array.from({ length: 501 }, () => ({ key: "agent:a", x: 0, y: 0 })))).rejects.toThrow();
  await expect(map.savePositions(user, [{ key: "agent:a", x: Number.POSITIVE_INFINITY, y: 0 }])).rejects.toThrow();
  await expect(map.savePositions({ ...user, apiKey: { id: "read", access: "read" } }, [])).rejects.toThrow();
  expect(edited()).toHaveLength(2);
});
