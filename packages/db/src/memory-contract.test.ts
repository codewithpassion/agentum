import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import { memoryChanges } from "./schema/memory.ts";
import { workspaces } from "./schema/workspaces.ts";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_NEVER_REMEMBER_JSON,
  DEFAULT_REMEMBER_RULES,
  DEFAULT_REMEMBER_RULES_JSON,
  LEARN_LEVELS,
  MEMORY_NOTE_KINDS,
  NEEDS_YOU_HEADINGS,
  NEEDS_YOU_KINDS,
  type RememberRules,
} from "./shared.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

interface Column {
  name: string;
  notnull: number;
}

const MEMORY_CHANGES_NULLABLE = [
  "agent_id",
  "decided_at",
  "decided_by",
  "dream_run_id",
  "group_id",
  "library_version_id",
  "source_id",
  "source_kind",
  "team_id",
  "user_scope",
];

const MEMORY_CHANGES_COLUMNS = [
  "action",
  "created_at",
  ...MEMORY_CHANGES_NULLABLE,
  "id",
  "kind",
  "note_id",
  "status",
  "text",
  "workspace_id",
  "written_by",
];

const agent = (id: string) => ({
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
  workspaceId: "w1",
});

test("memory_changes has exactly the documented columns, nullable where the design says", () => {
  const { client } = migrated();
  const columns = client
    .query<Column, []>("PRAGMA table_info(memory_changes)")
    .all();

  expect(columns.map((c) => c.name).sort()).toEqual(
    [...MEMORY_CHANGES_COLUMNS].sort()
  );
  for (const column of columns) {
    const nullable = MEMORY_CHANGES_NULLABLE.includes(column.name);
    expect(column.notnull, column.name).toBe(nullable ? 0 : 1);
  }
});

test("a bare workspace insert gets the default never_remember list", () => {
  const { client } = migrated();
  client.run(
    "INSERT INTO workspaces (id, clerk_org_id, created_at, name, timezone) VALUES ('w1', 'org_w1', ?, 'w1', 'UTC')",
    [NOW]
  );
  const row = client
    .query<{ never_remember: string }, []>(
      "SELECT never_remember FROM workspaces WHERE id = 'w1'"
    )
    .get();

  expect(row?.never_remember).toBe(DEFAULT_NEVER_REMEMBER_JSON);
  expect(JSON.parse(row?.never_remember ?? "null")).toEqual([
    ...DEFAULT_NEVER_REMEMBER,
  ]);
});

test("a bare agent insert gets the default remember rules", () => {
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
    .query<{ remember: string }, []>(
      "SELECT remember FROM agents WHERE id = 'a1'"
    )
    .get();

  expect(row?.remember).toBe(DEFAULT_REMEMBER_RULES_JSON);
  const rules: RememberRules = JSON.parse(row?.remember ?? "null");
  expect(rules.learnLevel).toBe("tell_after");
  expect(rules.shareWithTeam).toBe(true);
  expect(rules.dreamSchedule).toBe("nightly");
  expect(rules.remember).toEqual([]);
  expect(rules.never).toEqual([]);
  expect(rules).toEqual(DEFAULT_REMEMBER_RULES);
});

test("the memory note kinds and learn levels are the documented sets", () => {
  expect([...MEMORY_NOTE_KINDS]).toEqual([
    "people",
    "corrections",
    "work",
    "places",
  ]);
  expect([...LEARN_LEVELS]).toEqual(["ask_first", "tell_after", "quiet"]);
});

test("the Needs you kinds include memory_note with a heading that names the agent", () => {
  expect(NEEDS_YOU_KINDS).toContain("memory_note");
  expect(NEEDS_YOU_HEADINGS.memory_note("Ada")).toContain("Ada");
});

test("a memory change inserts for an agent and reads back as applied", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(agents).values(agent("a1")).run();
  db.insert(memoryChanges)
    .values({
      action: "add",
      agentId: "a1",
      createdAt: NOW,
      id: "mc1",
      kind: "people",
      noteId: "n1",
      status: "applied",
      text: "Ada prefers morning calls.",
      workspaceId: "w1",
      writtenBy: "agent",
    })
    .run();

  const [row] = db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.id, "mc1"))
    .all();
  expect(row?.status).toBe("applied");
  expect(row?.agentId).toBe("a1");
  expect(row?.libraryVersionId).toBeNull();
});

test("a memory change pointing at an unknown library version is refused", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(agents).values(agent("a1")).run();

  expect(() =>
    db
      .insert(memoryChanges)
      .values({
        action: "add",
        agentId: "a1",
        createdAt: NOW,
        id: "mc2",
        kind: "work",
        libraryVersionId: "lv_missing",
        noteId: "n2",
        status: "applied",
        text: "Ships on Fridays.",
        workspaceId: "w1",
        writtenBy: "dream",
      })
      .run()
  ).toThrow();
});
