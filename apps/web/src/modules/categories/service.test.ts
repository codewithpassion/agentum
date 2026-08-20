import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, type Db } from "#/db/client";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
import { categoryItems } from "./schema";
import {
  assignItem,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  renameCategory,
  unassignItem,
} from "./service";

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/**
 * The service talks to D1; `bun test` has `bun:sqlite`. This is the smallest
 * adapter between the two - the three statement methods drizzle's D1 driver
 * calls, over an in-memory database with the real migrations applied.
 */
const createTestDb = (): Db => {
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

  const client = {
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
  };

  return createDb(client as unknown as D1Database);
};

describe("categories service", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  test("lists the categories it created", async () => {
    await createCategory(db, DEFAULT_WORKSPACE_ID, { name: "Product" });
    await createCategory(db, DEFAULT_WORKSPACE_ID, { name: "Ops" });

    const listed = await listCategories(db);
    expect(listed.map((category) => category.name).sort()).toEqual([
      "Ops",
      "Product",
    ]);
    expect(listed.every((category) => category.items.length === 0)).toBe(true);
  });

  test("renames a category and reports a missing one", async () => {
    const category = await createCategory(db, DEFAULT_WORKSPACE_ID, {
      name: "Product",
    });

    expect(await renameCategory(db, category.id, "Platform")).toEqual({
      id: category.id,
      items: [],
      name: "Platform",
    });
    expect(await renameCategory(db, "missing", "Platform")).toBeUndefined();
  });

  test("moves an item when it is assigned to another category", async () => {
    const product = await createCategory(db, DEFAULT_WORKSPACE_ID, {
      name: "Product",
    });
    const ops = await createCategory(db, DEFAULT_WORKSPACE_ID, { name: "Ops" });
    const item = { itemId: "channel-1", itemType: "channel" as const };

    await assignItem(db, product.id, item);
    expect(await getCategory(db, product.id)).toEqual({
      id: product.id,
      items: [item],
      name: "Product",
    });

    await assignItem(db, ops.id, item);
    expect((await getCategory(db, product.id))?.items).toEqual([]);
    expect((await getCategory(db, ops.id))?.items).toEqual([item]);
  });

  test("unassigns an item without touching its siblings", async () => {
    const product = await createCategory(db, DEFAULT_WORKSPACE_ID, {
      name: "Product",
    });
    const channel = { itemId: "channel-1", itemType: "channel" as const };
    const agent = { itemId: "agent-1", itemType: "agent" as const };

    await assignItem(db, product.id, channel);
    await assignItem(db, product.id, agent);
    await unassignItem(db, channel);

    expect((await getCategory(db, product.id))?.items).toEqual([agent]);
  });

  test("deleting a category leaves its items uncategorized", async () => {
    const product = await createCategory(db, DEFAULT_WORKSPACE_ID, {
      name: "Product",
    });
    await assignItem(db, product.id, {
      itemId: "channel-1",
      itemType: "channel",
    });

    expect(await deleteCategory(db, product.id)).toBe(true);
    expect(await deleteCategory(db, product.id)).toBe(false);
    expect(await getCategory(db, product.id)).toBeUndefined();
    expect(await db.select().from(categoryItems)).toEqual([]);
  });
});
