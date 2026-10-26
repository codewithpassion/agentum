import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import { runs } from "./schema/runs.ts";
import { sessions } from "./schema/sessions.ts";
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

const agent = (id: string, workspaceId: string, emailLocal?: string) => ({
  createdAt: NOW,
  createdBy: "u1",
  emailLocal,
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

test("the migration applies on a fresh database", () => {
  const { client } = migrated();
  const columns = client
    .query<{ name: string }, []>("PRAGMA table_info(agents)")
    .all()
    .map((row) => row.name);
  expect(columns).toEqual(
    expect.arrayContaining(["email_local", "hands_to", "soul"])
  );
});

test("an agent inserted without soul or hands_to gets the defaults", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  const [row] = db.select().from(agents).where(eq(agents.id, "a1")).all();
  expect(row?.soul).toBe("");
  expect(row?.handsTo).toBe("[]");
  expect(row?.emailLocal).toBeNull();
});

test("a raw insert that omits soul and hands_to gets the column defaults", () => {
  const { client } = migrated();
  client.run(
    "INSERT INTO workspaces (id, clerk_org_id, created_at, name, timezone) VALUES ('w1', 'org_w1', ?, 'w1', 'UTC')",
    [NOW]
  );
  client.run(
    "INSERT INTO agents (id, workspace_id, created_at, created_by, instructions, model, name, runtime, runtime_config, slug, status) VALUES ('a1', 'w1', ?, 'u1', '', 'm', 'a1', 'fake', '{}', 'a1', 'active')",
    [NOW]
  );
  const row = client
    .query<{ hands_to: string; soul: string }, []>(
      "SELECT soul, hands_to FROM agents WHERE id = 'a1'"
    )
    .get();
  expect(row).toEqual({ hands_to: "[]", soul: "" });
});

test("two agents with the same email_local in one workspace fail", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents)
    .values(agent("a1", "w1", "scout"))
    .run();
  expect(() =>
    db
      .insert(agents)
      .values(agent("a2", "w1", "scout"))
      .run()
  ).toThrow("UNIQUE constraint failed");
});

test("two agents with the same email_local in different workspaces fail", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(workspaces).values(workspace("w2")).run();
  db.insert(agents)
    .values(agent("a1", "w1", "scout"))
    .run();
  expect(() =>
    db
      .insert(agents)
      .values(agent("a2", "w2", "scout"))
      .run()
  ).toThrow("UNIQUE constraint failed");
});

test("many agents with a NULL email_local all insert", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents)
    .values([1, 2, 3, 4].map((n) => agent(`a${n}`, "w1")))
    .run();
  const rows = db.select().from(agents).all();
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.emailLocal === null)).toBe(true);
});

test("a run inserted without dry_run reads back dryRun false", () => {
  const db = migrated();
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
      status: "queued",
      workspaceId: "w1",
    })
    .run();
  const [row] = db.select().from(runs).where(eq(runs.id, "r1")).all();
  expect(row?.dryRun).toBe(false);
});
