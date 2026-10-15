import { beforeEach, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { sqliteAtomic } from "./atomic.ts";
import { files } from "./schema/files.ts";
import { migrated } from "./test-db.ts";

const file = (id: string) => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  createdById: "u1",
  createdByKind: "user",
  id,
  mime: "text/plain",
  name: id,
  r2Key: `w1/files/${id}`,
  size: 1,
  source: "upload" as const,
  workspaceId: "w1",
});

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const rowCount = () => db.select({ n: count() }).from(files).get()?.n;

describe("sqliteAtomic", () => {
  test("commits every statement", async () => {
    const atomic = sqliteAtomic(db);
    await atomic([
      db.insert(files).values(file("a")),
      db.insert(files).values(file("b")),
    ]);
    expect(rowCount()).toBe(2);
  });

  test("a failing second statement rolls back the first", async () => {
    const atomic = sqliteAtomic(db);
    await expect(
      atomic([
        db.insert(files).values(file("a")),
        db.insert(files).values(file("a")), // duplicate primary key
      ])
    ).rejects.toThrow();
    expect(rowCount()).toBe(0);
  });

  test("an empty list is a no-op", async () => {
    await sqliteAtomic(db)([]);
    expect(rowCount()).toBe(0);
  });
});
