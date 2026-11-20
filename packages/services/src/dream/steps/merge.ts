// Ported from the-brain/packages/db/src/dream/judge.ts and apply.ts (the merge
// verdict, and the confidence floor below which a merge is not made) and from
// dedup.ts (confirm a near duplicate with the model, then fold it into one
// row). The Brain folds entities. Here one judge call reads one group of notes
// of one kind and one userScope, and each verdict folds notes into a keeper.
// The prompt is adapted from the Brain's DREAM_JUDGE_SYSTEM.
import type {
  DreamPlanChange,
  MemoryNote,
  MemoryNoteKind,
} from "@repo/db/shared";
import { hasFreshEvidence, isFreshEvidence } from "./evidence.ts";
import {
  type MergeGroup,
  mergeChange,
  notesAfterMerge,
  parseMergeGroups,
  pickKeeper,
  type StepResult,
} from "./groups.ts";
import {
  AUTO_APPLY_FLOOR,
  askJudge,
  type Judge,
  normalizeText,
  oneLine,
} from "./judge.ts";

/** A note a dream proposes to add. The same shape as the `add` change of a DreamPlan. */
export type NoteCandidate = Extract<DreamPlanChange, { action: "add" }>;

type AddChange = NoteCandidate;
type MergeChange = Extract<DreamPlanChange, { action: "merge" }>;
type DropChange = Extract<DreamPlanChange, { action: "drop" }>;

const REPLACED_REASON = "A newer note of another kind replaces it";

export interface MergeInput {
  candidates: readonly NoteCandidate[];
  judge: Judge;
  notes: readonly MemoryNote[];
  /** `YYYY-MM-DD`, the day a merged note is written. */
  today: string;
}

export interface MergeResult extends StepResult {
  /** Groups whose judge answer was null or unparseable. */
  skippedGroups: number;
}

const MERGE_SYSTEM = `You are a memory-consolidation judge. You get the notes an agent keeps, all for one owner, and each line names the note's kind. Find the notes that say the same thing, or nearly the same thing, and should become one clean note. A newer note that corrects or replaces an older one, even of another kind, goes in a group with the older note, and its text is the corrected one. Reply with ONE JSON object and no prose, shaped like {"groups":[{"ids":[string],"text":string,"confidence":number,"rationale":string}]}. Each group has at least two ids and a confidence from 0 to 1. Its text is the single merged note, on one line, under 500 characters. Notes that are distinct, or that disagree, go in no group. Use the exact ids you are given.`;

/** One note the judge may see: an existing note, or a candidate not yet kept. */
interface Item {
  fresh: boolean;
  kind: MemoryNoteKind;
  /** A note's id, or `new-<n>` for a candidate. The only ids the judge may name. */
  label: string;
  /** The existing note, or null for a candidate. */
  note: MemoryNote | null;
  source: NoteCandidate["source"];
  text: string;
  userScope: string | null;
}

interface State {
  adds: AddChange[];
  consumed: Set<string>;
  drops: DropChange[];
  merges: MergeChange[];
  notes: MemoryNote[];
  skippedGroups: number;
}

const exactKey = (
  kind: MemoryNoteKind,
  userScope: string | null,
  text: string
): string => JSON.stringify([kind, userScope, normalizeText(text)]);

/** The candidates whose text passes the note rule and that repeat neither an existing note nor an earlier candidate. */
const newCandidates = (
  candidates: readonly NoteCandidate[],
  notes: readonly MemoryNote[]
): NoteCandidate[] => {
  const seen = new Set(
    notes.map((note) => exactKey(note.kind, note.userScope, note.text))
  );
  const kept: NoteCandidate[] = [];
  for (const candidate of candidates) {
    const text = oneLine(candidate.text);
    if (text === null) {
      continue;
    }
    const key = exactKey(candidate.kind, candidate.userScope, text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push({
      action: "add",
      kind: candidate.kind,
      source: candidate.source,
      text,
      userScope: candidate.userScope,
    });
  }
  return kept;
};

/** Folds existing notes that repeat each other exactly, when one of them is fresh evidence. No judge call. */
const foldExactDuplicates = (
  notes: readonly MemoryNote[],
  today: string
): { merges: MergeChange[]; notes: MemoryNote[] } => {
  const byText = new Map<string, MemoryNote[]>();
  for (const note of notes) {
    const key = exactKey(note.kind, note.userScope, note.text);
    const group = byText.get(key);
    if (group) {
      group.push(note);
    } else {
      byText.set(key, [note]);
    }
  }
  const merges: MergeChange[] = [];
  let working = [...notes];
  for (const group of byText.values()) {
    const keeper = pickKeeper(group);
    if (group.length < 2 || keeper === null || !hasFreshEvidence(group)) {
      continue;
    }
    const merge = mergeChange(
      keeper,
      group.filter((note) => note.id !== keeper.id),
      keeper.text
    );
    merges.push(merge);
    working = notesAfterMerge(working, merge, today);
  }
  return { merges, notes: working };
};

/** `new-<n>`, or one more `_` when an existing note already holds that id. */
const candidateLabel = (
  ordinal: number,
  taken: ReadonlySet<string>
): string => {
  let label = `new-${ordinal}`;
  while (taken.has(label)) {
    label = `${label}_`;
  }
  return label;
};

const noteItem = (note: MemoryNote): Item => ({
  fresh: isFreshEvidence(note),
  kind: note.kind,
  label: note.id,
  note,
  source: null,
  text: note.text,
  userScope: note.userScope,
});

const candidateItems = (
  candidates: readonly NoteCandidate[],
  taken: ReadonlySet<string>
): Item[] =>
  candidates.map((candidate, index) => ({
    fresh: true,
    kind: candidate.kind,
    label: candidateLabel(index + 1, taken),
    note: null,
    source: candidate.source,
    text: candidate.text,
    userScope: candidate.userScope,
  }));

const addOf = (item: Item, text: string): AddChange => ({
  action: "add",
  kind: item.kind,
  source: item.source,
  text,
  userScope: item.userScope,
});

const renderItem = (item: Item): string =>
  item.note === null
    ? `- id=${item.label} (kind ${item.kind}, by new): ${item.text}`
    : `- id=${item.label} (kind ${item.kind}, by ${item.note.writtenBy}, ${item.note.date}): ${item.text}`;

const groupPrompt = (group: readonly Item[]): string =>
  `Notes:\n${group.map(renderItem).join("\n")}\n\nReply with the JSON object.`;

/** The answer with every group removed that names an id the judge was not shown. Such a group makes no change at all. */
const dropGroupsNamingUnknownIds = (
  answer: Record<string, unknown>,
  labels: ReadonlySet<string>
): Record<string, unknown> => {
  if (!Array.isArray(answer.groups)) {
    return answer;
  }
  return {
    ...answer,
    groups: answer.groups.filter((entry) => namesOnlyShownIds(entry, labels)),
  };
};

const namesOnlyShownIds = (
  entry: unknown,
  labels: ReadonlySet<string>
): boolean => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const { ids } = entry as Record<string, unknown>;
  return (
    Array.isArray(ids) &&
    ids.every((id) => typeof id === "string" && labels.has(id))
  );
};

/** The verdicts for one group, or null when the judge gave no usable answer. */
const judgeGroup = async (
  group: readonly Item[],
  judge: Judge
): Promise<MergeGroup[] | null> => {
  const labels = new Set(group.map((item) => item.label));
  const answer = await askJudge(judge, groupPrompt(group), MERGE_SYSTEM);
  if (answer === null) {
    return null;
  }
  return parseMergeGroups(dropGroupsNamingUnknownIds(answer, labels), labels);
};

const itemNote = (item: Item): MemoryNote[] =>
  item.note === null ? [] : [item.note];

/** Splits items into groups of one `userScope`, in first-seen order. A group may mix kinds, so a correction meets the note it corrects. */
const userScopeGroups = (items: readonly Item[]): Item[][] => {
  const groups = new Map<string | null, Item[]>();
  for (const item of items) {
    const group = groups.get(item.userScope);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.userScope, [item]);
    }
  }
  return [...groups.values()];
};

/** The kind a merged note takes: a newcomer's, else that of the existing note with the latest date. */
const newestKind = (
  newcomers: readonly Item[],
  existing: readonly MemoryNote[]
): MemoryNoteKind | null => {
  const [firstNewcomer] = newcomers;
  if (firstNewcomer) {
    return firstNewcomer.kind;
  }
  const latest = existing.reduce<MemoryNote | null>(
    (best, note) => (best === null || note.date > best.date ? note : best),
    null
  );
  return latest?.kind ?? null;
};

/** No existing note has the newer note's kind: the older notes are dropped and the newer note is added with its own kind. */
const replaceOtherKinds = (
  existing: readonly MemoryNote[],
  newcomer: Item | undefined,
  text: string,
  state: State
): void => {
  if (!newcomer) {
    return;
  }
  const gone = new Set(existing.map((note) => note.id));
  for (const id of gone) {
    state.drops.push({ action: "drop", noteId: id, reason: REPLACED_REASON });
  }
  state.adds.push(addOf(newcomer, text));
  state.notes = state.notes.filter((note) => !gone.has(note.id));
};

/** Applies one verdict: a merge into the keeper, an add for candidates alone, or nothing. */
const applyVerdict = (
  group: readonly Item[],
  verdict: MergeGroup,
  today: string,
  state: State
): void => {
  if (verdict.confidence < AUTO_APPLY_FLOOR) {
    return;
  }
  const members = group.filter((item) => verdict.ids.includes(item.label));
  if (!members.some((item) => item.fresh)) {
    return;
  }
  const newcomers = members.filter((item) => item.note === null);
  for (const item of newcomers) {
    state.consumed.add(item.label);
  }
  const existing = members.flatMap(itemNote);
  const [firstNewcomer] = newcomers;
  if (existing.length === 0) {
    if (firstNewcomer) {
      state.adds.push(addOf(firstNewcomer, verdict.text));
    }
    return;
  }
  const kind = newestKind(newcomers, existing);
  const keeper = pickKeeper(existing.filter((note) => note.kind === kind));
  if (keeper === null) {
    replaceOtherKinds(existing, firstNewcomer, verdict.text, state);
    return;
  }
  const absorbed = existing.filter((note) => note.id !== keeper.id);
  if (
    absorbed.length === 0 &&
    normalizeText(verdict.text) === normalizeText(keeper.text)
  ) {
    return;
  }
  // With no absorbed note and new text, this merge edits the keeper in place.
  // DR.4 applies that as an edit.
  const merge = mergeChange(keeper, absorbed, verdict.text);
  state.merges.push(merge);
  state.notes = notesAfterMerge(state.notes, merge, today);
};

/** A group is worth a judge call when it has two items and at least one of them is fresh evidence. */
const needsJudge = (group: readonly Item[]): boolean =>
  group.length >= 2 && group.some((item) => item.fresh);

const applyGroup = (
  group: readonly Item[],
  verdicts: MergeGroup[] | null,
  input: MergeInput,
  state: State
): void => {
  if (verdicts === null) {
    state.skippedGroups += 1;
    return;
  }
  for (const verdict of verdicts) {
    applyVerdict(group, verdict, input.today, state);
  }
};

/**
 * Finds the merges and adds for a batch of candidate notes. Exact duplicates
 * are folded or dropped with no model call. Near duplicates go to the judge,
 * one call per group of one userScope, whatever the kinds.
 */
export const mergeNotes = async (input: MergeInput): Promise<MergeResult> => {
  const candidates = newCandidates(input.candidates, input.notes);
  const folded = foldExactDuplicates(input.notes, input.today);
  const pending = candidateItems(
    candidates,
    new Set(input.notes.map((note) => note.id))
  );
  const items = [...folded.notes.map(noteItem), ...pending];
  const state: State = {
    adds: [],
    consumed: new Set(),
    drops: [],
    merges: folded.merges,
    notes: folded.notes,
    skippedGroups: 0,
  };
  const groups = userScopeGroups(items).filter(needsJudge);
  const judged = await Promise.all(
    groups.map(async (group) => ({
      group,
      verdicts: await judgeGroup(group, input.judge),
    }))
  );
  for (const { group, verdicts } of judged) {
    applyGroup(group, verdicts, input, state);
  }
  const leftover = pending
    .filter((item) => !state.consumed.has(item.label))
    .map((item) => addOf(item, item.text));
  return {
    changes: [...state.merges, ...state.drops, ...state.adds, ...leftover],
    notes: state.notes,
    skippedGroups: state.skippedGroups,
  };
};
