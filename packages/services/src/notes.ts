// Business rules for notes. Callers (the tRPC router, a script, a test) go
// through here; `@repo/db/notes` only stores and reads.
import type { Database } from "@repo/db";
import { createNote, listNotes } from "@repo/db/notes";
import { NOTE_TEXT_MAX_LENGTH, type Note } from "@repo/db/shared";
import { z } from "zod";

/** Also the tRPC input schema, so the router and the service agree. */
export const createNoteInput = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Note text must not be empty.")
    .max(
      NOTE_TEXT_MAX_LENGTH,
      `Note text must be at most ${NOTE_TEXT_MAX_LENGTH} characters.`
    ),
});

export type CreateNoteInput = z.input<typeof createNoteInput>;

export interface NotesService {
  /** Validates (trims, length-checks) and stores a note. Throws on bad input. */
  create: (input: CreateNoteInput) => Promise<Note>;
  /** Newest notes first. */
  list: () => Promise<Note[]>;
}

export const createNotesService = (db: Database): NotesService => ({
  // async so a validation error rejects the promise instead of throwing
  // synchronously.
  create: async (input) => {
    const data = createNoteInput.parse(input);
    return await createNote(db, data);
  },
  list: () => listNotes(db),
});
