import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, type Db } from "#/db/client";

/**
 * What deleting one channel takes with it, and what it must not touch.
 *
 * The rows inside this module follow by `ON DELETE CASCADE` and are not the
 * interesting part. The interesting part is everything that does not: the R2
 * objects the attachment rows name, and the rows in other modules that key off
 * a bare channel id with no foreign key and no workspace of their own to check.
 */

// `env` as well as the base class: the mock is global to the run, and a
// sibling file importing `env` from this module would otherwise fail to load.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { deleteChannel, listMessageIdsForChannel } = await import("./service");
const { deleteBridgesForChannel } = await import("#/modules/bridges/bridges");
const { deleteOverridesForChannel } = await import(
  "#/modules/agents/model-overrides"
);
const { deleteQuestionsForChannel } = await import(
  "#/modules/questions/service"
);

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

const createTestD1 = (): D1Database => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }
  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

/** Writes into the caller's map, so a test can see what is still stored. */
const fakeBucket = (stored: Map<string, string>): R2Bucket =>
  ({
    delete(key: string | string[]) {
      for (const one of typeof key === "string" ? [key] : key) {
        stored.delete(one);
      }
      return Promise.resolve();
    },
  }) as unknown as R2Bucket;

const ALPHA = "ws_alpha";
const BETA = "ws_beta";

let db: Db;
let d1: D1Database;
let objects: Map<string, string>;
let bucket: R2Bucket;

const run = async (sql: string, ...params: SQLQueryBindings[]) => {
  await d1
    .prepare(sql)
    .bind(...params)
    .run();
};

const rows = async (sql: string, ...params: SQLQueryBindings[]) =>
  (
    await d1
      .prepare(sql)
      .bind(...params)
      .all()
  ).results as unknown[];

/** One channel with a message, an attachment, and a row in every module that names a channel. */
const seed = async (workspaceId: string, suffix: string) => {
  const channelId = `chan_${suffix}`;
  const messageId = `msg_${suffix}`;
  const r2Key = `attachments/${suffix}.png`;

  await run(
    "insert into channels (id, workspace_id, name, kind) values (?, ?, ?, 'channel')",
    channelId,
    workspaceId,
    `room-${suffix}`
  );
  await run(
    "insert into messages (id, channel_id, author_type, author_id, body) values (?, ?, 'user', 'user_1', 'hello')",
    messageId,
    channelId
  );
  await run(
    "insert into attachments (id, message_id, r2_key, filename, mime, size) values (?, ?, ?, 'a.png', 'image/png', 1)",
    `att_${suffix}`,
    messageId,
    r2Key
  );
  await run(
    "insert into external_refs (id, connector, internal_type, internal_id, external_id) values (?, 'slack', 'message', ?, ?)",
    `ref_${suffix}`,
    messageId,
    `slack_${suffix}`
  );
  await run(
    "insert into channel_bridges (id, workspace_id, channel_id, connector, external_channel_id, agent_id, slack_app_id) values (?, ?, ?, 'slack', ?, 'agent_1', ?)",
    `bridge_${suffix}`,
    workspaceId,
    channelId,
    `C${suffix}`,
    `app_${suffix}`
  );
  await run(
    "insert into agent_questions (id, workspace_id, channel_id, message_id, agent_id, kind, prompt, status) values (?, ?, ?, ?, 'agent_1', 'permission', 'may i?', 'pending')",
    `q_${suffix}`,
    workspaceId,
    channelId,
    messageId
  );
  await run(
    "insert into agent_model_overrides (id, workspace_id, agent_id, channel_id, thread_parent_id, model, created_by) values (?, ?, 'agent_1', ?, '', 'claude-opus-5', 'agent:agent_1')",
    `ovr_${suffix}`,
    workspaceId,
    channelId
  );

  objects.set(r2Key, "png bytes");
  return { channelId, messageId, r2Key };
};

/** What the route does, in the order it does it. */
const deleteEverything = async (workspaceId: string, channelId: string) => {
  const { deleteExternalRefsForMessages } = await import(
    "#/modules/bridges/refs"
  );
  await deleteExternalRefsForMessages(
    db,
    await listMessageIdsForChannel(db, channelId)
  );
  await deleteBridgesForChannel(db, workspaceId, channelId);
  await deleteQuestionsForChannel(db, workspaceId, channelId);
  await deleteOverridesForChannel(db, workspaceId, channelId);
  return await deleteChannel(db, bucket, workspaceId, channelId);
};

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1);
  objects = new Map();
  bucket = fakeBucket(objects);
});

describe("deleting one channel", () => {
  test("takes its messages, attachments and stored objects with it", async () => {
    const alpha = await seed(ALPHA, "a");

    expect(await deleteEverything(ALPHA, alpha.channelId)).toBe(true);

    expect(await rows("select id from channels")).toHaveLength(0);
    expect(await rows("select id from messages")).toHaveLength(0);
    expect(await rows("select id from attachments")).toHaveLength(0);
    // The row cascades; the object behind it only goes if the key was read first.
    expect(objects.has(alpha.r2Key)).toBe(false);
  });

  test("takes the rows in other modules that name it", async () => {
    const alpha = await seed(ALPHA, "a");

    await deleteEverything(ALPHA, alpha.channelId);

    expect(await rows("select id from external_refs")).toHaveLength(0);
    expect(await rows("select id from channel_bridges")).toHaveLength(0);
    expect(await rows("select id from agent_questions")).toHaveLength(0);
    expect(await rows("select id from agent_model_overrides")).toHaveLength(0);
  });

  test("leaves another workspace's channel and everything under it alone", async () => {
    const alpha = await seed(ALPHA, "a");
    const beta = await seed(BETA, "b");

    await deleteEverything(ALPHA, alpha.channelId);

    expect(
      await rows("select id from channels where id = ?", beta.channelId)
    ).toHaveLength(1);
    expect(
      await rows("select id from messages where id = ?", beta.messageId)
    ).toHaveLength(1);
    expect(await rows("select id from channel_bridges")).toHaveLength(1);
    expect(await rows("select id from agent_questions")).toHaveLength(1);
    expect(await rows("select id from agent_model_overrides")).toHaveLength(1);
    expect(await rows("select id from external_refs")).toHaveLength(1);
    expect(objects.has(beta.r2Key)).toBe(true);
  });

  test("refuses a channel id belonging to another workspace", async () => {
    const beta = await seed(BETA, "b");

    // The route checks the channel resolves in the workspace before it deletes
    // anything; this is the same answer from the service itself.
    expect(await deleteChannel(db, bucket, ALPHA, beta.channelId)).toBe(false);
    expect(await rows("select id from channels")).toHaveLength(1);
    expect(objects.has(beta.r2Key)).toBe(true);
  });

  test("says no for a channel that never existed", async () => {
    expect(await deleteChannel(db, bucket, ALPHA, "chan_nope")).toBe(false);
  });
});
