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
const graph = () =>
  createMapService({
    clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
    db,
    requests: { listPending: async () => pending },
  }).graph(user, { days: 7 });
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
      ["library", 1],
      ["library", 1],
      ["qa", 2],
      ["email", 1],
    ].sort()
  );
  expect(result.nodes.map((n) => n.key)).toContain(
    "out:library:agents/a/tasks/child"
  );
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
  for (const to of [
    "out:slack:old-channel",
    "out:library:agents/a/tasks/parent",
  ]) {
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
