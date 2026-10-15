import { desc } from "drizzle-orm";
import { type Database, notes } from "./schema.ts";
import type { Note } from "./shared.ts";

/** How a note is stored. Only this module sees the numeric id. */
type NoteRow = typeof notes.$inferSelect;

const DEFAULT_LIST_LIMIT = 20;

function toNote(row: NoteRow): Note {
  return {
    createdAt: row.createdAt,
    id: String(row.id),
    text: row.text,
  };
}

/** Newest notes first. */
export async function listNotes(
  db: Database,
  limit = DEFAULT_LIST_LIMIT
): Promise<Note[]> {
  const rows = await db
    .select()
    .from(notes)
    .orderBy(desc(notes.id))
    .limit(limit);
  return rows.map(toNote);
}

/**
 * Stores a note as given. Validation is the caller's job: go through
 * `@repo/services/notes`, which trims and length-checks the text first.
 */
export async function createNote(
  db: Database,
  input: { text: string }
): Promise<Note> {
  const [row] = await db
    .insert(notes)
    .values({ createdAt: new Date().toISOString(), text: input.text })
    .returning();
  if (!row) {
    throw new Error("Note was inserted but could not be read back.");
  }
  return toNote(row);
}
