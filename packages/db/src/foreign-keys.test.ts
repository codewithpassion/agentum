import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import { runRequests } from "./schema/requests.ts";
import { runs } from "./schema/runs.ts";
import { sessions } from "./schema/sessions.ts";
import { agentToolRules } from "./schema/tool-rules.ts";
import { triggers } from "./schema/triggers.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const workspace = (id: string) => ({
  clerkOrgId: `org_${id}`,
  createdAt: NOW,
  id,
  name: id,
  timezone: "UTC",
});

const agent = (id: string, workspaceId: string) => ({
  createdAt: NOW,
  createdBy: "u1",
  id,
  instructions: "",
  model: "m",
  name: id,
  runtime: "fake" as const,
  runtimeConfig: "{}",
  slug: id,
  status: "active",
  workspaceId,
});

test("an insert with an unknown workspace_id throws", () => {
  const db = migrated();
  expect(() => db.insert(agents).values(agent("a1", "nope")).run()).toThrow(
    "FOREIGN KEY constraint failed"
  );
});

test("an insert with an unknown nullable reference throws, and null is fine", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  expect(() =>
    db
      .insert(agents)
      .values({ ...agent("a1", "w1"), machineId: "nope" })
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  db.insert(agents).values(agent("a2", "w1")).run();
  expect(db.select().from(agents).all()).toHaveLength(1);
});

test("deleting a referenced workspace throws", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  expect(() =>
    db.delete(workspaces).where(eq(workspaces.id, "w1")).run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(db.select().from(workspaces).all()).toHaveLength(1);
});

test("deleting an agent cascades to its triggers", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  db.insert(triggers)
    .values({
      agentId: "a1",
      createdAt: NOW,
      createdBy: "u1",
      id: "t1",
      kind: "http",
      name: "t",
      tokenHash: "h",
      tokenPrefix: "hm_trg_abcd",
      workspaceId: "w1",
    })
    .run();
  db.delete(agents).where(eq(agents.id, "a1")).run();
  expect(db.select().from(triggers).all()).toHaveLength(0);
});

const seedRun = (db: ReturnType<typeof migrated>) => {
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "s1",
      origin: "ui",
      workspaceId: "w1",
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "r1",
      inputText: "hi",
      sessionId: "s1",
      status: "waiting",
      workspaceId: "w1",
    })
    .run();
};

const request = (overrides: Partial<typeof runRequests.$inferInsert> = {}) => ({
  agentId: "a1",
  createdAt: NOW,
  display: "{}",
  expiresAt: NOW,
  id: "q1",
  kind: "approval" as const,
  runId: "r1",
  sessionId: "s1",
  status: "pending" as const,
  toolName: "Bash",
  toolUseId: "tu1",
  workspaceId: "w1",
  ...overrides,
});

test("a request stores a waiting run, refuses a second row for the same tool use, and refuses an unknown run or agent", () => {
  const db = migrated();
  seedRun(db);
  db.insert(runRequests).values(request()).run();
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ id: "q2" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(runRequests)
    .values(request({ id: "q3", toolUseId: "tu2" }))
    .run();
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ id: "q4", runId: "nope", toolUseId: "tu3" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ agentId: "nope", id: "q5", toolUseId: "tu4" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("a tool rule is unique per agent and tool key, and refuses an unknown agent", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  const rule = (id: string, agentId: string, toolKey: string) => ({
    agentId,
    id,
    mode: "ask" as const,
    toolKey,
    updatedAt: NOW,
    updatedBy: "u1",
    workspaceId: "w1",
  });
  db.insert(agentToolRules)
    .values(rule("t1", "a1", "Bash"))
    .run();
  db.insert(agentToolRules)
    .values(rule("t2", "a1", "Write"))
    .run();
  expect(() =>
    db
      .insert(agentToolRules)
      .values(rule("t3", "a1", "Bash"))
      .run()
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    db
      .insert(agentToolRules)
      .values(rule("t4", "nope", "Bash"))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});
