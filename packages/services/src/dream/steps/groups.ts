// Helpers the steps share. `scopeGroups` (reconcile, prune, team) is the Brain's cluster
// homogeneity rule (select.ts: every cluster is one kind and one tier, so a
// merged fact has one unambiguous home; dream.canary.test.ts case (h) and
// entity-dedup.test.ts "different kind" and "different scope partition"). A
// note's tier is its `userScope`, so private text never joins shared text.
import type {
  DreamPlan,
  DreamPlanChange,
  MemoryNote,
  MemoryNoteKind,
} from "@repo/db/shared";
import { clampConfidence, idsFrom, normalizeText, oneLine } from "./judge.ts";

/** What a step returns: the changes it proposes, and the notes as they stand once they apply. */
export interface StepResult {
  changes: DreamPlan;
  /**
   * The input notes after the changes, so the next step works on what is left.
   * A note a plan adds is not in here, even though it has an id by reconcile.
   */
  notes: MemoryNote[];
}

interface Scoped {
  kind: MemoryNoteKind;
  userScope: string | null;
}

/** Splits items into groups of one kind and one `userScope`, in first-seen order. */
export const scopeGroups = <T extends Scoped>(items: readonly T[]): T[][] => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.userScope]);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return [...groups.values()];
};

const WRITER_RANK: Record<MemoryNote["writtenBy"], number> = {
  agent: 1,
  dream: 2,
  person: 0,
};

const byKeeperOrder = (a: MemoryNote, b: MemoryNote): number => {
  const writer = WRITER_RANK[a.writtenBy] - WRITER_RANK[b.writtenBy];
  if (writer !== 0) {
    return writer;
  }
  if (a.date !== b.date) {
    return a.date < b.date ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
};

/** The note that stays when notes merge: a person's first, then the agent's, then a dream's, then the oldest, then the smaller id. */
export const pickKeeper = (notes: readonly MemoryNote[]): MemoryNote | null =>
  [...notes].sort(byKeeperOrder)[0] ?? null;

/** One group of notes the judge says should become a single note. */
export interface MergeGroup {
  confidence: number;
  ids: string[];
  text: string;
}

/**
 * The `groups` of a judge answer: each at least two known ids and a text that
 * passes the note rule. A group that names an id an earlier group took is
 * skipped, so groups never overlap. Ids the judge made up are dropped.
 */
export const parseMergeGroups = (
  answer: Record<string, unknown>,
  valid: ReadonlySet<string>
): MergeGroup[] => {
  if (!Array.isArray(answer.groups)) {
    return [];
  }
  const claimed = new Set<string>();
  const groups: MergeGroup[] = [];
  for (const raw of answer.groups) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const ids = idsFrom(entry.ids, valid);
    const text = oneLine(entry.text);
    if (ids.length < 2 || text === null || ids.some((id) => claimed.has(id))) {
      continue;
    }
    for (const id of ids) {
      claimed.add(id);
    }
    groups.push({ confidence: clampConfidence(entry.confidence), ids, text });
  }
  return groups;
};

/**
 * The `merge` change for a keeper that takes `text` and absorbs `absorbed`.
 * `absorbed` may be empty: the keeper then only takes new text, an edit in
 * place. `DreamPlan` has no edit action and `codec.apply` rejects a merge with
 * nothing absorbed, so DR.4 applies an empty-absorbed merge as an `edit`.
 *
 * Writer and date rule for DR.4: a merge whose `text` equals the keeper's text
 * (an exact duplicate folded in) leaves the keeper's `written_by` and `date`
 * as they were. Only a merge that changes the text writes the keeper as
 * `dream` with the day of the dream. `notesAfterMerge` assumes the same, and
 * the next steps rely on it for who counts as fresh evidence.
 */
export const mergeChange = (
  keeper: MemoryNote,
  absorbed: readonly MemoryNote[],
  text: string
): Extract<DreamPlanChange, { action: "merge" }> => ({
  absorbedNoteIds: absorbed.map((note) => note.id),
  action: "merge",
  keepNoteId: keeper.id,
  // Text that differs from the keeper's only in case, spacing or a closing
  // full stop is the keeper's text, so the plan and notesAfterMerge agree.
  text: normalizeText(text) === normalizeText(keeper.text) ? keeper.text : text,
});

/**
 * The notes after a merge. The keeper that takes new text also takes, as the
 * memory service writes an edit, the day and the writer `dream`, so a later
 * step sees it as dream-written. A keeper whose text does not change is left
 * as it was, so folding an exact duplicate does not turn a person's note into
 * dream output. The absorbed notes are gone.
 */
export const notesAfterMerge = (
  notes: readonly MemoryNote[],
  merge: Extract<DreamPlanChange, { action: "merge" }>,
  today: string
): MemoryNote[] => {
  const gone = new Set(merge.absorbedNoteIds);
  return notes
    .filter((note) => !gone.has(note.id))
    .map((note) =>
      note.id === merge.keepNoteId &&
      normalizeText(note.text) !== normalizeText(merge.text)
        ? { ...note, date: today, text: merge.text, writtenBy: "dream" }
        : note
    );
};

/** One prompt line for a note: its id, who wrote it, its date and its text. */
export const renderNote = (label: string, note: MemoryNote): string =>
  `- id=${label} (by ${note.writtenBy}, ${note.date}): ${note.text}`;
