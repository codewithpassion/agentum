import { expect, test } from "bun:test";
import { migrated } from "./test-db.ts";

interface Column {
  dflt_value: string | null;
  name: string;
  notnull: number;
}

const NO_WORKSPACE_ID = new Set(["workspaces", "__drizzle_migrations"]);

test("the foundation, connector and OAuth client tables exist", () => {
  const { client } = migrated();
  const names = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name)
    .filter((name) => name !== "__drizzle_migrations");
  expect(names).toEqual([
    "agent_connectors",
    "agent_secrets",
    "agent_tool_rules",
    "agents",
    "api_keys",
    "connectors",
    "credentials",
    "events",
    "files",
    "identity_links",
    "inbox_posts",
    "inbox_threads",
    "library_entries",
    "machine_enroll_tokens",
    "machines",
    "managed_agents",
    "managed_runs",
    "managed_sessions",
    "managed_skill_versions",
    "managed_skills",
    "oauth_clients",
    "oauth_states",
    "run_requests",
    "runs",
    "secrets",
    "sessions",
    "skill_assignments",
    "skill_library_migrations",
    "skill_version_files",
    "skill_versions",
    "skills",
    "slack_apps",
    "slack_events_seen",
    "slack_messages",
    "slack_threads",
    "triggers",
    "workspace_anthropic_keys",
    "workspace_model_keys",
    "workspaces",
  ]);
});

test("every table except workspaces has workspace_id NOT NULL with no default", () => {
  const { client } = migrated();
  const tables = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !NO_WORKSPACE_ID.has(name));
  expect(tables.length).toBe(38);

  for (const table of tables) {
    const column = client
      .query<Column, []>(`PRAGMA table_info(${table})`)
      .all()
      .find((c) => c.name === "workspace_id");
    expect(column?.notnull, table).toBe(1);
    expect(column?.dflt_value, table).toBeNull();
  }
});
