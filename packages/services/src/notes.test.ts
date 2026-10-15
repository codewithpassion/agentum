// Runs against a throwaway in-memory SQLite database with the same migrations
// D1 gets, so no server and no network are involved.
import { Database as Sqlite } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { NOTE_TEXT_MAX_LENGTH } from "@repo/db/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createNotesService, type NotesService } from "./notes.ts";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../db/migrations");

let notes: NotesService;

beforeEach(() => {
  const db = drizzle(new Sqlite(":memory:"));
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  notes = createNotesService(db);
});

describe("notes service", () => {
  test("create trims the text before storing it", async () => {
    const note = await notes.create({ text: "  hello  " });

    expect(note.text).toBe("hello");
    expect(await notes.list()).toEqual([note]);
  });

  test("create rejects empty and over-long text without storing it", async () => {
    await expect(notes.create({ text: "   " })).rejects.toThrow(
      "must not be empty"
    );
    await expect(
      notes.create({ text: "x".repeat(NOTE_TEXT_MAX_LENGTH + 1) })
    ).rejects.toThrow("at most");
    expect(await notes.list()).toEqual([]);
  });

  test("create accepts text at the limit", async () => {
    const text = "x".repeat(NOTE_TEXT_MAX_LENGTH);

    expect((await notes.create({ text })).text).toBe(text);
  });

  test("list returns newest first", async () => {
    await notes.create({ text: "first" });
    await notes.create({ text: "second" });

    expect((await notes.list()).map((n) => n.text)).toEqual([
      "second",
      "first",
    ]);
  });
});
