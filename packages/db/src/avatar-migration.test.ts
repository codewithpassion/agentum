import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultAgentAvatar, NEUTRAL_AGENT_AVATAR_JSON } from "./shared.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const NOW = "2026-01-01T00:00:00.000Z";
const SEEDED_NAMES = ["Ada", "bob", "élan", "Zed", "🙂 smile"] as const;

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.findIndex((name) =>
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes("`avatar`")
);

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const openBeforeTarget = (): Sqlite => {
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files.slice(0, targetIndex)) {
    apply(client, name);
  }
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES ('org_w1', ?, 'w1', 'w1', 'UTC')`,
    [NOW]
  );
  return client;
};

const seedAgent = (client: Sqlite, id: string, name: string) => {
  client.run(
    `INSERT INTO agents (created_at, created_by, id, instructions, model, name, runtime, runtime_config, slug, status, workspace_id)
     VALUES (?, 'u1', ?, '', 'm', ?, 'fake', '{}', ?, 'active', 'w1')`,
    [NOW, id, name, id]
  );
};

test("the avatar backfill gives existing agents the TypeScript default", () => {
  expect(targetIndex).toBeGreaterThan(0);
  const client = openBeforeTarget();
  for (const [index, name] of SEEDED_NAMES.entries()) {
    seedAgent(client, `avatar-${index}`, name);
  }
  apply(client, files[targetIndex] ?? "");
  const rows = client
    .query<{ avatar: string; name: string }, []>(
      "SELECT name, avatar FROM agents ORDER BY id"
    )
    .all();
  expect(rows.map((row) => row.name)).toEqual([...SEEDED_NAMES]);
  for (const row of rows) {
    expect(JSON.parse(row.avatar)).toEqual(defaultAgentAvatar(row.name));
  }
});

test("an agent inserted after every migration without an avatar gets the column default", () => {
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files) {
    apply(client, name);
  }
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES ('org_w1', ?, 'w1', 'w1', 'UTC')`,
    [NOW]
  );
  seedAgent(client, "fresh", "Fresh");
  const row = client
    .query<{ avatar: string }, []>(
      "SELECT avatar FROM agents WHERE id = 'fresh'"
    )
    .get();
  expect(row?.avatar).toBe(NEUTRAL_AGENT_AVATAR_JSON);
});
