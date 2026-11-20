// A dream question's options are stored as JSON in `dream_questions.options`.
// The table has no scope column, so each option carries the `userScope` of the
// notes the question is about: all of one kind and one scope (DR.2). A question
// about a private note belongs to that person alone, and the desk, the rail and
// `dream.answer` read the scope from here.
import type { DreamQuestionOption } from "@repo/db/shared";
import { z } from "zod";

const storedSchema = z.array(
  z.object({
    // The member agent that holds the note. Only a team dream's question names one.
    agentId: z.string().nullable().default(null),
    noteId: z.string(),
    text: z.string(),
    userScope: z.string().nullable().default(null),
  })
);

export interface QuestionOptions {
  options: DreamQuestionOption[];
  /** The person the question belongs to, or null for a question about shared notes. */
  userScope: string | null;
}

export const storeOptions = (
  options: readonly DreamQuestionOption[],
  userScope: string | null
): string =>
  JSON.stringify(
    options.map(({ noteId, text }) => ({ noteId, text, userScope }))
  );

/** A team dream's options: shared notes, each with the member that holds it. */
export const storeTeamOptions = (
  options: readonly (DreamQuestionOption & { agentId: string })[]
): string =>
  JSON.stringify(
    options.map(({ agentId, noteId, text }) => ({
      agentId,
      noteId,
      text,
      userScope: null,
    }))
  );

/** The member agent that holds each note of a team question, by note id. Empty for an agent's question. */
export const readHolders = (raw: string): Map<string, string> => {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return new Map(
      (parsed.success ? parsed.data : []).flatMap((option) =>
        option.agentId === null
          ? []
          : [[option.noteId, option.agentId] as const]
      )
    );
  } catch {
    return new Map();
  }
};

/** The options and scope of a stored question. A value that does not parse reads as no options, shared. */
export const readOptions = (raw: string): QuestionOptions => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { options: [], userScope: null };
  }
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) {
    return { options: [], userScope: null };
  }
  return {
    options: parsed.data.map(({ noteId, text }) => ({ noteId, text })),
    userScope: parsed.data[0]?.userScope ?? null,
  };
};
