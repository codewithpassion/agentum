// The Brain keeps dream output out of the next dream's evidence: `select.ts`
// reads only facts with `is_dream_generated = 0`, so a consolidated fact is
// never consolidated again (dream.canary.test.ts, case (e)). Its hygiene pass
// is the exception, because it only ages facts. The steps here follow the same
// split, with `written_by: dream` as the marker:
//
// - merge and reconcile act only when a group holds fresh evidence, and a
//   dream-written note never wins a conflict, never makes a group worth
//   judging on its own, and is the last choice for the note a merge keeps;
// - prune can still age out or condense a dream-written note, because that
//   uses no other note as a reason.
import type { MemoryNote } from "@repo/db/shared";

/** True for a note a person or the agent wrote. A note a dream wrote is not evidence for another change. */
export const isFreshEvidence = (note: Pick<MemoryNote, "writtenBy">): boolean =>
  note.writtenBy !== "dream";

/** True when at least one note in the group is fresh evidence. */
export const hasFreshEvidence = (
  notes: readonly Pick<MemoryNote, "writtenBy">[]
): boolean => notes.some(isFreshEvidence);
