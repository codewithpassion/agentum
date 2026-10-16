import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
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
