import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { inboxThreadMembers, inboxThreads } from "./schema/inbox.ts";
import { memberProfiles, teamMembers, teams } from "./schema/teams.ts";
import { workspaces } from "./schema/workspaces.ts";
import { CONTEXT_BUDGETS, EFFORT_LEVELS, TEAM_MEMBER_KINDS } from "./shared.ts";
import { migrated } from "./test-db.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const TARGET = "0057_famous_nocturne.sql";
const NOW = "2026-01-01T00:00:00.000Z";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.indexOf(TARGET);

interface Column {
  dflt_value: string | null;
  name: string;
  notnull: number;
}

interface TeamRow {
  archived_at: string | null;
  created_at: string;
  id: string;
  lead_agent_id: string | null;
  lead_listens: number;
  name: string;
  owner_user_id: string | null;
  rules: string;
  slug: string;
  workspace_id: string;
}

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const seedWorkspace = (client: Sqlite, id: string) => {
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES (?, ?, ?, ?, 'UTC')`,
    [`org_${id}`, NOW, id, id]
  );
};

const seedThread = (client: Sqlite, id: string, workspaceId: string) => {
  client.run(
    `INSERT INTO inbox_threads (created_at, created_by, id, last_post_at, title, workspace_id)
     VALUES (?, 'u1', ?, ?, ?, ?)`,
    [NOW, id, NOW, id, workspaceId]
  );
};

const seedTeam = (
  client: Sqlite,
  id: string,
  workspaceId: string,
  slug: string
) => {
  client.run(
    `INSERT INTO teams (created_at, id, name, slug, workspace_id)
     VALUES (?, ?, ?, ?, ?)`,
    [NOW, id, slug, slug, workspaceId]
  );
};

const columnsOf = (client: Sqlite, table: string) =>
  client.query<Column, []>(`PRAGMA table_info(${table})`).all();

test("the migration gives each workspace an Everyone team and moves its threads into it", () => {
  expect(targetIndex).toBeGreaterThan(0);
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files.slice(0, targetIndex)) {
    apply(client, name);
  }
  seedWorkspace(client, "w1");
  seedWorkspace(client, "w2");
  seedWorkspace(client, "w3");
  seedThread(client, "t1", "w1");
  seedThread(client, "t2", "w1");
  seedThread(client, "t3", "w2");
  client.run(
    `INSERT INTO inbox_posts (author_id, author_kind, created_at, file_ids, id, run_id, text, thread_id, workspace_id)
     VALUES ('u1', 'user', ?, '[]', 'p1', NULL, 'hello', 't1', 'w1')`,
    [NOW]
  );

  apply(client, TARGET);

  const rows = client
    .query<TeamRow, []>("SELECT * FROM teams ORDER BY workspace_id")
    .all();
  expect(rows.map((row) => row.workspace_id)).toEqual(["w1", "w2", "w3"]);
  for (const row of rows) {
    expect(row.slug).toBe("everyone");
    expect(row.name).toBe("Everyone");
    expect(row.lead_agent_id).toBeNull();
    expect(row.owner_user_id).toBeNull();
    expect(row.rules).toBe("");
    expect(row.lead_listens).toBe(1);
    expect(row.archived_at).toBeNull();
    expect(row.id).not.toBe("");
    expect(row.created_at).toMatch(ISO_TIMESTAMP);
  }
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);

  const teamOf = new Map(rows.map((row) => [row.workspace_id, row.id]));
  const threads = client
    .query<{ id: string; team_id: string | null }, []>(
      "SELECT id, team_id FROM inbox_threads ORDER BY id"
    )
    .all();
  expect(threads).toEqual([
    { id: "t1", team_id: teamOf.get("w1") ?? null },
    { id: "t2", team_id: teamOf.get("w1") ?? null },
    { id: "t3", team_id: teamOf.get("w2") ?? null },
  ]);

  const joined = client
    .query<{ post_id: string; thread_id: string }, []>(
      `SELECT inbox_posts.id AS post_id, inbox_threads.id AS thread_id
       FROM inbox_posts JOIN inbox_threads ON inbox_threads.id = inbox_posts.thread_id`
    )
    .all();
  expect(joined).toEqual([{ post_id: "p1", thread_id: "t1" }]);

  const [membership] = client
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM team_members")
    .all();
  expect(membership?.n).toBe(0);
});

test("the inbox and team columns are nullable with no default", () => {
  const { client } = migrated();
  for (const name of ["team_id", "opened_by_agent_id"]) {
    const column = columnsOf(client, "inbox_threads").find(
      (c) => c.name === name
    );
    expect(column?.notnull, `inbox_threads.${name}`).toBe(0);
    expect(column?.dflt_value, `inbox_threads.${name}`).toBeNull();
  }
});

test("inbox_threads is indexed by team and recency", () => {
  const { client } = migrated();
  const indexes = client
    .query<{ name: string }, []>("PRAGMA index_list(inbox_threads)")
    .all();
  const teamIndex = indexes.find((i) => i.name === "inbox_threads_team_idx");
  expect(teamIndex).toBeDefined();
  const indexed = client
    .query<{ name: string }, []>("PRAGMA index_info(inbox_threads_team_idx)")
    .all();
  expect(indexed[0]?.name).toBe("team_id");
});

test("a team defaults to led and to empty rules, and a team member defaults to not home", () => {
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
  seedTeam(db.client, "t1", "w1", "sales");
  db.client.run(
    "INSERT INTO team_members (member_id, member_kind, team_id, workspace_id) VALUES ('a1', 'agent', 't1', 'w1')"
  );

  const [team] = db.client
    .query<{ lead_listens: number; rules: string }, []>(
      "SELECT lead_listens, rules FROM teams WHERE id = 't1'"
    )
    .all();
  expect(team?.lead_listens).toBe(1);
  expect(team?.rules).toBe("");

  const [member] = db.client
    .query<{ is_home: number }, []>(
      "SELECT is_home FROM team_members WHERE team_id = 't1'"
    )
    .all();
  expect(member?.is_home).toBe(0);
});

test("a team slug is unique within a workspace and reusable in another", () => {
  const { client } = migrated();
  seedWorkspace(client, "w1");
  seedWorkspace(client, "w2");
  seedTeam(client, "t1", "w1", "sales");
  expect(() => seedTeam(client, "t2", "w1", "sales")).toThrow(
    "UNIQUE constraint failed"
  );
  seedTeam(client, "t3", "w2", "sales");
});

test("a member handle is unique within a workspace and reusable in another", () => {
  const { client } = migrated();
  seedWorkspace(client, "w1");
  seedWorkspace(client, "w2");
  const insertProfile = (workspaceId: string, userId: string, handle: string) =>
    client.run(
      `INSERT INTO member_profiles (handle, name, user_id, workspace_id)
       VALUES (?, ?, ?, ?)`,
      [handle, handle, userId, workspaceId]
    );
  insertProfile("w1", "user_a", "ada");
  expect(() => insertProfile("w1", "user_b", "ada")).toThrow(
    "UNIQUE constraint failed"
  );
  insertProfile("w2", "user_b", "ada");
});

test("a team member is unique per team, kind and member", () => {
  const { client } = migrated();
  seedWorkspace(client, "w1");
  seedTeam(client, "t1", "w1", "sales");
  const insertMember = () =>
    client.run(
      "INSERT INTO team_members (member_id, member_kind, team_id, workspace_id) VALUES ('a1', 'agent', 't1', 'w1')"
    );
  insertMember();
  expect(insertMember).toThrow("UNIQUE constraint failed");
});

test("deleting a team deletes its members", () => {
  const { client } = migrated();
  seedWorkspace(client, "w1");
  seedTeam(client, "t1", "w1", "sales");
  client.run(
    "INSERT INTO team_members (member_id, member_kind, team_id, workspace_id) VALUES ('a1', 'agent', 't1', 'w1'), ('user_a', 'user', 't1', 'w1')"
  );
  client.run("DELETE FROM teams WHERE id = 't1'");
  const [remaining] = client
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM team_members")
    .all();
  expect(remaining?.n).toBe(0);
});

test("deleting a thread deletes its member rows", () => {
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
  seedThread(db.client, "t1", "w1");
  db.insert(inboxThreadMembers)
    .values({
      memberId: "user_a",
      memberKind: "user",
      threadId: "t1",
      workspaceId: "w1",
    })
    .run();

  db.delete(inboxThreads).where(eq(inboxThreads.id, "t1")).run();

  const remaining = db
    .select()
    .from(inboxThreadMembers)
    .where(eq(inboxThreadMembers.threadId, "t1"))
    .all();
  expect(remaining).toEqual([]);
});

test("member profiles and team members can be read back through drizzle", () => {
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
  db.insert(memberProfiles)
    .values({ handle: "ada", name: "Ada", userId: "user_a", workspaceId: "w1" })
    .run();
  db.insert(teams)
    .values({
      createdAt: NOW,
      id: "t1",
      name: "Sales",
      slug: "sales",
      workspaceId: "w1",
    })
    .run();
  db.insert(teamMembers)
    .values({
      memberId: "user_a",
      memberKind: "user",
      teamId: "t1",
      workspaceId: "w1",
    })
    .run();

  const [profile] = db.select().from(memberProfiles).all();
  expect(profile?.handle).toBe("ada");
  const [team] = db.select().from(teams).all();
  expect(team?.leadListens).toBe(true);
  expect(team?.rules).toBe("");
  const [member] = db.select().from(teamMembers).all();
  expect(member?.isHome).toBe(false);
});

test("the team member kinds, effort levels and context budgets are the documented sets", () => {
  expect([...TEAM_MEMBER_KINDS]).toEqual(["agent", "user"]);
  expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high"]);
  expect([...CONTEXT_BUDGETS]).toEqual(["small", "standard", "large"]);
});
