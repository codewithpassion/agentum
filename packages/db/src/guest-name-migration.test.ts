import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const NOW = "2026-01-01T00:00:00.000Z";

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.findIndex((name) =>
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes(
    "`guest_name`"
  )
);

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const seedPost = (
  client: Sqlite,
  post: { authorId: string; authorKind: string; id: string; text: string }
) => {
  client.run(
    `INSERT INTO inbox_posts (author_id, author_kind, created_at, id, text, thread_id, workspace_id)
     VALUES (?, ?, ?, ?, ?, 't1', 'w1')`,
    [post.authorId, post.authorKind, NOW, post.id, post.text]
  );
};

test("a guest's name moves out of the text, and no other post changes", () => {
  expect(targetIndex).toBeGreaterThan(0);
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
  client.run(
    `INSERT INTO inbox_threads (created_at, created_by, id, last_post_at, title, workspace_id)
     VALUES (?, 'slack:T1:U1', 't1', ?, 'Topic', 'w1')`,
    [NOW, NOW]
  );
  seedPost(client, {
    authorId: "slack:T1:U1",
    authorKind: "user",
    id: "guest",
    text: "Ada Lovelace (Slack guest): hello (Slack guest): again",
  });
  seedPost(client, {
    authorId: "slack:T1:U2",
    authorKind: "user",
    id: "bare",
    text: "no prefix here",
  });
  seedPost(client, {
    authorId: "user_1",
    authorKind: "user",
    id: "member",
    text: "Bob (Slack guest): quoted by a member",
  });
  seedPost(client, {
    authorId: "agent_1",
    authorKind: "agent",
    id: "agent",
    text: "Done",
  });

  apply(client, files[targetIndex] ?? "");

  const rows = client
    .query<{ guest_name: string | null; id: string; text: string }, []>(
      "SELECT id, guest_name, text FROM inbox_posts ORDER BY id"
    )
    .all();
  expect(rows).toEqual([
    { guest_name: null, id: "agent", text: "Done" },
    { guest_name: "Someone", id: "bare", text: "no prefix here" },
    {
      guest_name: "Ada Lovelace",
      id: "guest",
      text: "hello (Slack guest): again",
    },
    {
      guest_name: null,
      id: "member",
      text: "Bob (Slack guest): quoted by a member",
    },
  ]);
});
