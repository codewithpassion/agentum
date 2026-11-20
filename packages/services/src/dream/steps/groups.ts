// Helpers the three steps share. `scopeGroups` is the Brain's cluster
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
import { isFreshEvidence } from "./evidence.ts";
import { clampConfidence, idsFrom, oneLine } from "./judge.ts";

/** What a step returns: the changes it proposes, and the notes as they stand once they apply. */
export interface StepResult {
  changes: DreamPlan;
  /** The input notes after the changes. A step run next never names a note twice. */
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

const byKeeperOrder = (a: MemoryNote, b: MemoryNote): number => {
  const evidence = Number(isFreshEvidence(b)) - Number(isFreshEvidence(a));
  if (evidence !== 0) {
    return evidence;
  }
  if (a.date !== b.date) {
    return a.date < b.date ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
};

/** The note that stays when notes merge: a note a person or the agent wrote first, then the oldest, then the smaller id. */
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

/** The `merge` change for a keeper that takes `text` and absorbs `absorbed`. */
export const mergeChange = (
  keeper: MemoryNote,
  absorbed: readonly MemoryNote[],
  text: string
): Extract<DreamPlanChange, { action: "merge" }> => ({
  absorbedNoteIds: absorbed.map((note) => note.id),
  action: "merge",
  keepNoteId: keeper.id,
  text,
});

/**
 * The notes after a merge. The keeper takes the text and, as the memory service
 * writes an edit, the day and the writer `dream`, so a later step sees it as
 * dream-written. The absorbed notes are gone.
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
      note.id === merge.keepNoteId
        ? { ...note, date: today, text: merge.text, writtenBy: "dream" }
        : note
    );
};

/** One prompt line for a note: its id, who wrote it, its date and its text. */
export const renderNote = (label: string, note: MemoryNote): string =>
  `- id=${label} (by ${note.writtenBy}, ${note.date}): ${note.text}`;
