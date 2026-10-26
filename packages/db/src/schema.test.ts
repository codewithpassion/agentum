import { expect, test } from "bun:test";
import {
  EVENT_TYPES,
  MACHINE_ROLES,
  NEEDS_YOU_KINDS,
  REQUEST_KINDS,
} from "./shared.ts";
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
    "agent_library_access",
    "agent_mailboxes",
    "agent_secrets",
    "agent_tool_rules",
    "agents",
    "api_keys",
    "browser_sessions",
    "connectors",
    "credentials",
    "events",
    "files",
    "identity_links",
    "inbox_posts",
    "inbox_threads",
    "library_conflicts",
    "library_entries",
    "library_links",
    "library_versions",
    "machine_credentials",
    "machine_enroll_tokens",
    "machines",
    "mail_messages",
    "mail_threads",
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
    "wiki_suggestions",
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
  expect(tables.length).toBe(48);

  for (const table of tables) {
    const column = client
      .query<Column, []>(`PRAGMA table_info(${table})`)
      .all()
      .find((c) => c.name === "workspace_id");
    expect(column?.notnull, table).toBe(1);
    expect(column?.dflt_value, table).toBeNull();
  }
});

test("the computer columns are nullable and the enrol token defaults to agent_host", () => {
  const { client } = migrated();
  const columns = (table: string) =>
    client.query<Column, []>(`PRAGMA table_info(${table})`).all();
  const find = (table: string, name: string) =>
    columns(table).find((c) => c.name === name);

  for (const name of [
    "computer_capabilities",
    "computer_last_seen_at",
    "computer_status",
  ]) {
    expect(find("machines", name)?.notnull, name).toBe(0);
  }
  expect(find("agents", "computer_machine_id")?.notnull).toBe(0);
  expect(find("machine_enroll_tokens", "machine_id")?.notnull).toBe(0);
  const role = find("machine_enroll_tokens", "role");
  expect(role?.notnull).toBe(1);
  expect(role?.dflt_value).toBe("'agent_host'");
});

test("agents.computer_machine_id is a partial unique index", () => {
  const { client } = migrated();
  const index = client
    .query<{ name: string; unique: number; partial: number }, []>(
      "PRAGMA index_list(agents)"
    )
    .all()
    .find((row) => row.name === "agents_computer_machine_unique");
  expect(index?.unique).toBe(1);
  expect(index?.partial).toBe(1);
});

test("machines was not rebuilt, so no __new_machines table exists", () => {
  const { client } = migrated();
  const row = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name LIKE '%__new_%'"
    )
    .all();
  expect(row).toEqual([]);
});

test("the shared module names the machine roles, the computer events and the takeover kind", () => {
  expect(MACHINE_ROLES).toEqual(["agent_host", "computer"]);
  for (const type of [
    "computer.online",
    "computer.offline",
    "computer.exec",
    "computer.file",
    "computer.takeover_requested",
    "computer.taken",
    "computer.handed_back",
    "browser.action",
  ]) {
    expect(EVENT_TYPES).toContain(type as never);
  }
  expect(REQUEST_KINDS).toContain("takeover");
  expect(NEEDS_YOU_KINDS).toContain("takeover");
});
