import { expect, test } from "bun:test";
import {
  EVENT_TYPES,
  MACHINE_ROLES,
  NEEDS_YOU_KINDS,
  QA_STATUSES,
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
    "artifact_ask_dispatches",
    "artifact_comment_threads",
    "artifact_comments",
    "artifact_grants",
    "artifact_live_changes",
    "artifact_members",
    "artifact_mention_deliveries",
    "artifact_pins",
    "artifact_room_invalidations",
    "artifact_shares",
    "artifact_version_files",
    "artifact_versions",
    "artifact_view_salts",
    "artifact_views",
    "artifacts",
    "browser_sessions",
    "connectors",
    "credentials",
    "events",
    "files",
    "guest_auth_rate_buckets",
    "guest_codes",
    "guest_comment_effects",
    "guest_comment_runs",
    "guest_identities",
    "guest_invites",
    "guest_run_scopes",
    "guest_sessions",
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
    "map_positions",
    "oauth_clients",
    "oauth_states",
    "qa_answers",
    "qa_questions",
    "run_requests",
    "runs",
    "secrets",
    "sessions",
    "skill_assignments",
    "skill_library_migrations",
    "skill_sources",
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
  expect(tables.length).toBe(75);

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

test("workspaces.artifact_links_enabled is NOT NULL, defaults to 1 and is true on a bare insert", () => {
  const db = migrated();
  const column = db.client
    .query<Column, []>("PRAGMA table_info(workspaces)")
    .all()
    .find((c) => c.name === "artifact_links_enabled");
  expect(column?.notnull).toBe(1);
  // drizzle writes the boolean default as the SQL literal `true`, which SQLite stores as 1.
  expect(column?.dflt_value).toBe("true");
  db.client.run(
    "INSERT INTO workspaces (id, clerk_org_id, created_at, name, timezone) VALUES ('w1', 'org_w1', 'x', 'w1', 'UTC')"
  );
  expect(
    db.client
      .query<{ artifact_links_enabled: number }, []>(
        "SELECT artifact_links_enabled FROM workspaces WHERE id = 'w1'"
      )
      .get()?.artifact_links_enabled
  ).toBe(1);
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

const indexColumns = (
  client: ReturnType<typeof migrated>["client"],
  index: string
) =>
  client
    .query<{ name: string }, []>(`PRAGMA index_info(${index})`)
    .all()
    .map((row) => row.name);

test("the Q&A tables carry the questions index, the answers index and no accepted-answer key", () => {
  const { client } = migrated();
  expect(indexColumns(client, "qa_questions_status_idx")).toEqual([
    "workspace_id",
    "status",
    "created_at",
  ]);
  expect(indexColumns(client, "qa_answers_question_idx")).toEqual([
    "question_id",
    "created_at",
  ]);
  const keys = client
    .query<{ from: string; table: string }, []>(
      "PRAGMA foreign_key_list(qa_questions)"
    )
    .all();
  expect(keys.map((key) => key.from).sort()).toEqual([
    "run_id",
    "workspace_id",
  ]);
  const column = client
    .query<Column, []>("PRAGMA table_info(qa_questions)")
    .all()
    .find((c) => c.name === "accepted_answer_id");
  expect(column?.notnull).toBe(0);
  expect(QA_STATUSES).toEqual(["open", "answered", "closed"]);
});

test("a skill source is keyed by its skill and indexed by checked_at", () => {
  const { client } = migrated();
  const columns = client
    .query<Column & { pk: number }, []>("PRAGMA table_info(skill_sources)")
    .all();
  expect(columns.find((c) => c.pk === 1)?.name).toBe("skill_id");
  expect(columns.find((c) => c.name === "path")?.notnull).toBe(0);
  expect(columns.find((c) => c.name === "latest_commit_sha")?.notnull).toBe(0);
  expect(columns.find((c) => c.name === "commit_sha")?.notnull).toBe(1);
  expect(indexColumns(client, "skill_sources_checked_idx")).toEqual([
    "checked_at",
  ]);
  const version = client
    .query<Column, []>("PRAGMA table_info(skill_versions)")
    .all()
    .find((c) => c.name === "source_commit_sha");
  expect(version?.notnull).toBe(0);
});

test("map positions are keyed by workspace and node", () => {
  const { client } = migrated();
  const keyed = client
    .query<{ name: string; pk: number }, []>("PRAGMA table_info(map_positions)")
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  expect(keyed).toEqual(["workspace_id", "node_key"]);
});

test("the events type index exists and the events triggers survived the migration", () => {
  const { client } = migrated();
  expect(indexColumns(client, "events_workspace_type_created_idx")).toEqual([
    "workspace_id",
    "type",
    "created_at",
  ]);
  const triggers = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'"
    )
    .all();
  expect(triggers).toHaveLength(2);
  const rebuilt = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name LIKE '%__new_%'"
    )
    .all();
  expect(rebuilt).toEqual([]);
});

test("the shared module names the Q&A, skill update and map events", () => {
  for (const type of [
    "qa.asked",
    "qa.answered",
    "qa.accepted",
    "qa.closed",
    "skill.update_available",
    "map.edited",
  ]) {
    expect(EVENT_TYPES).toContain(type as never);
  }
});

test("live columns preserve existing defaults and event immutability triggers", () => {
  const { client } = migrated();
  const columns = (table: string) =>
    client.query<Column, []>(`PRAGMA table_info(${table})`).all();
  expect(
    columns("workspaces").find((c) => c.name === "live_guests_enabled")
      ?.dflt_value
  ).toBe("true");
  for (const [table, name] of [
    ["artifacts", "live_room_rev"],
    ["artifacts", "converted_from_id"],
    ["runs", "scope_artifact_id"],
    ["artifact_views", "guest_id"],
  ] as const) {
    expect(columns(table).find((c) => c.name === name)?.notnull).toBe(0);
  }
  const triggers = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'"
    )
    .all();
  expect(triggers.map((t) => t.name).sort()).toEqual([
    "events_no_delete",
    "events_no_update",
  ]);
});
