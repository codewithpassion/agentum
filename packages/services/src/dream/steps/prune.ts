// Ported from the-brain/packages/db/src/dream/hygiene.ts, in shape only: a fact
// must be old enough before it can lapse. The Brain decays confidence from real
// recall traces and soft-expires a fact so it can come back. A note has no use
// signal, only the day it was written, and a `drop` is undone through the
// dream's undo, so the age rule here is blunter than the Brain's. The task asks
// for it as written: notes older than 60 days go. The merge verdict and its floor come from
// judge.ts and apply.ts (AUTO_APPLY_FLOOR), and the size budget reuses them.
// The finished-work pass and the size budget are new for notes.
import type { DreamPlanChange, MemoryNote } from "@repo/db/shared";
import {
  type MergeGroup,
  mergeChange,
  notesAfterMerge,
  parseMergeGroups,
  pickKeeper,
  renderNote,
  type StepResult,
  scopeGroups,
} from "./groups.ts";
import {
  AUTO_APPLY_FLOOR,
  askJudge,
  clampConfidence,
  type Judge,
} from "./judge.ts";

/** A note whose date is more than this many UTC days before today is dropped. */
export const STALE_DAYS = 60;

export interface PruneInput {
  /**
   * Notes the pass must neither drop nor merge, such as the ones a question
   * waits on (`ReconcileResult.held`). They still count toward the size.
   */
  held?: readonly string[];
  judge: Judge;
  /**
   * The most note text (sum of text lengths, as codec.budget counts) the notes
   * given may hold. A plan's `add` changes have no note here, so the caller
   * passes the budget less the text it adds.
   */
  maxChars: number;
  notes: readonly MemoryNote[];
  /** Today as `YYYY-MM-DD`. */
  today: string;
}

export interface PruneResult extends StepResult {
  /** Sum of the text lengths of `notes`. */
  chars: number;
}

interface Budget {
  chars: number;
  maxChars: number;
}

const DAY_MS = 86_400_000;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const STALE_REASON = `Not changed for ${STALE_DAYS} days`;
const FINISHED_REASON = "Work finished";

const FINISHED_SYSTEM = [
  "You are a memory-hygiene judge. Each note is work in progress that an agent keeps.",
  "A note is finished only if its own text says the work is done, delivered or closed.",
  "A note that is in progress, waiting, blocked or ongoing is not finished.",
  "Judge each note by its own text alone. No note is evidence about another note.",
  'Reply with ONE JSON object and no prose, in this shape: {"finished":[{"id":string,"confidence":number from 0 to 1,"rationale":string}]}.',
  "Use the exact ids given. Leave out every note that is not finished.",
].join("\n");

const BUDGET_SYSTEM = [
  "You are a memory-consolidation judge. The notes below hold more characters than the memory budget allows.",
  "Find notes about the same thing that can become one shorter note without losing a fact.",
  'Reply with ONE JSON object and no prose, in this shape: {"groups":[{"ids":[string],"text":string,"confidence":number from 0 to 1,"rationale":string}]}.',
  "Each group lists at least two ids. The text is one line, under 500 characters, and shorter than the notes it replaces together.",
  "Use the exact ids given.",
].join("\n");

const textLength = (notes: readonly MemoryNote[]): number =>
  notes.reduce((sum, note) => sum + note.text.length, 0);

const membersOf = (
  notes: readonly MemoryNote[],
  ids: readonly string[]
): MemoryNote[] => {
  const wanted = new Set(ids);
  return notes.filter((note) => wanted.has(note.id));
};

/** The time of a `YYYY-MM-DD` day at UTC midnight, or null when the text is not a real day. */
const dayTime = (value: string): number | null => {
  if (!DAY_SHAPE.test(value)) {
    return null;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  return time;
};

/**
 * The ids of notes more than STALE_DAYS old. `date` is the day of the last
 * write, not the last use, so a note the agent still uses can go stale.
 * A date that does not parse is never stale. Dream-written notes age too.
 */
const staleNoteIds = (
  notes: readonly MemoryNote[],
  today: string
): Set<string> => {
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const stale = new Set<string>();
  for (const note of notes) {
    const noteTime = dayTime(note.date);
    if (noteTime !== null && (todayTime - noteTime) / DAY_MS > STALE_DAYS) {
      stale.add(note.id);
    }
  }
  return stale;
};

const dropsFor = (
  notes: readonly MemoryNote[],
  ids: ReadonlySet<string>,
  reason: string
): DreamPlanChange[] =>
  notes
    .filter((note) => ids.has(note.id))
    .map(
      (note): DreamPlanChange => ({
        action: "drop",
        noteId: note.id,
        reason,
      })
    );

const promptFor = (intro: string, notes: readonly MemoryNote[]): string =>
  [intro, ...notes.map((note) => renderNote(note.id, note))].join("\n");

const finishedIdsIn = (
  answer: Record<string, unknown>,
  valid: ReadonlySet<string>
): string[] => {
  if (!Array.isArray(answer.finished)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of answer.finished) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const verdict = entry as Record<string, unknown>;
    const { confidence } = verdict;
    const { id } = verdict;
    if (
      typeof id === "string" &&
      valid.has(id) &&
      clampConfidence(confidence) >= AUTO_APPLY_FLOOR
    ) {
      ids.push(id);
    }
  }
  return ids;
};

/**
 * The work notes the judge calls finished. Work notes are judged one scope at a
 * time, so one person's private text never shares a call with another group.
 * A call the judge cannot answer marks nothing.
 */
const finishedNoteIds = async (
  judge: Judge,
  notes: readonly MemoryNote[]
): Promise<Set<string>> => {
  const groups = scopeGroups(notes.filter((note) => note.kind === "work"));
  const answers = await Promise.all(
    groups.map((group) =>
      askJudge(judge, promptFor("Work notes to judge:", group), FINISHED_SYSTEM)
    )
  );
  const finished = new Set<string>();
  for (const [index, answer] of answers.entries()) {
    const group = groups[index] ?? [];
    if (answer === null) {
      continue;
    }
    const valid = new Set(group.map((note) => note.id));
    for (const id of finishedIdsIn(answer, valid)) {
      finished.add(id);
    }
  }
  return finished;
};

/** The scope groups that can merge: two or more notes, the largest text first. */
const budgetGroups = (notes: readonly MemoryNote[]): MemoryNote[][] =>
  [...scopeGroups(notes)]
    .filter((group) => group.length >= 2)
    .sort((a, b) => textLength(b) - textLength(a));

/** The merge groups the judge proposes for one scope group that it can accept: confident, and shorter than their members. */
const judgeGroup = async (
  judge: Judge,
  group: readonly MemoryNote[],
  budget: Budget
): Promise<MergeGroup[]> => {
  const prompt = promptFor(
    `The memory budget is ${budget.maxChars} characters and the notes hold ${budget.chars}. These notes share a kind and a scope:`,
    group
  );
  const answer = await askJudge(judge, prompt, BUDGET_SYSTEM);
  if (answer === null) {
    return [];
  }
  const valid = new Set(group.map((note) => note.id));
  return parseMergeGroups(answer, valid).filter(
    (verdict) =>
      verdict.confidence >= AUTO_APPLY_FLOOR &&
      verdict.text.length < textLength(membersOf(group, verdict.ids))
  );
};

/**
 * Merges the notes until the text fits the budget. Each group is judged once,
 * and a merge stops as soon as the text fits. Nothing is cut or dropped here.
 */
const fitBudget = async (
  judge: Judge,
  maxChars: number,
  notes: readonly MemoryNote[],
  held: ReadonlySet<string>,
  today: string
): Promise<{ changes: DreamPlanChange[]; notes: MemoryNote[] }> => {
  const changes: DreamPlanChange[] = [];
  let current: MemoryNote[] = [...notes];
  for (const group of budgetGroups(
    notes.filter((note) => !held.has(note.id))
  )) {
    if (textLength(current) <= maxChars) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each group is judged only while the text is still over budget, so the calls must run in order
    const verdicts = await judgeGroup(judge, group, {
      chars: textLength(current),
      maxChars,
    });
    for (const verdict of verdicts) {
      if (textLength(current) <= maxChars) {
        break;
      }
      const members = membersOf(current, verdict.ids);
      const keeper = pickKeeper(members);
      if (keeper === null) {
        continue;
      }
      const absorbed = members.filter((note) => note.id !== keeper.id);
      const change = mergeChange(keeper, absorbed, verdict.text);
      changes.push(change);
      current = notesAfterMerge(current, change, today);
    }
  }
  return { changes, notes: current };
};

/**
 * Prunes the notes in three passes, in order: drop stale notes (no model call),
 * drop finished work (one judge call per work scope), then merge notes until the
 * text fits the budget. A null or unparseable judge answer changes nothing.
 */
export const pruneNotes = async (input: PruneInput): Promise<PruneResult> => {
  const held = new Set(input.held ?? []);
  const free = input.notes.filter((note) => !held.has(note.id));
  const stale = staleNoteIds(free, input.today);
  const afterAge = input.notes.filter((note) => !stale.has(note.id));
  const finished = await finishedNoteIds(
    input.judge,
    afterAge.filter((note) => !held.has(note.id))
  );
  const afterWork = afterAge.filter((note) => !finished.has(note.id));
  const budget = await fitBudget(
    input.judge,
    input.maxChars,
    afterWork,
    held,
    input.today
  );
  const changes = [
    ...dropsFor(input.notes, stale, STALE_REASON),
    ...dropsFor(afterAge, finished, FINISHED_REASON),
    ...budget.changes,
  ];
  return {
    changes,
    chars: textLength(budget.notes),
    notes: budget.notes,
  };
};
