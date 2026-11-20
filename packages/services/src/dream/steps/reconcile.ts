// Ported from the-brain/packages/db/src/dream/judge.ts (the `contradict`
// verdict: the facts genuinely disagree and a person must decide) and from
// the-brain/packages/db/src/dream/contradiction.ts and apply.ts (a contradiction
// is filed for a person instead of being settled, and a low-confidence verdict
// is downgraded to that). The Brain's `supersede` verdict becomes the code rule
// in `resolveConflict`, so the model never picks the winner.
import type { DreamPlanChange, MemoryNote } from "@repo/db/shared";
import { hasFreshEvidence } from "./evidence.ts";
import { renderNote, type StepResult, scopeGroups } from "./groups.ts";
import {
  AUTO_APPLY_FLOOR,
  askJudge,
  clampConfidence,
  idsFrom,
  type Judge,
  oneLine,
} from "./judge.ts";

export interface ReconcileResult extends StepResult {
  /**
   * The ids of the notes in a question. They stay in `notes`, but they wait for
   * a person's answer, so a later step (prune) must neither drop nor merge them.
   * A question names notes of one kind and one userScope, so DR.4 takes the
   * question's scope from them: the question text and its options carry note
   * text, and a private note's question belongs to that person alone.
   */
  held: string[];
}

export interface ReconcileInput {
  judge: Judge;
  notes: readonly MemoryNote[];
}

const PERSON_WINS_REASON = "A newer note from a person says otherwise";
const FALLBACK_QUESTION = "These notes disagree. Which one is right?";

const RECONCILE_SYSTEM =
  "You are a memory-conflict judge. You get notes an agent keeps for its owner, " +
  "all of one kind. Each line says who wrote the note (person, agent or dream) " +
  "and when. Find notes that disagree, so that both cannot be true or both " +
  "cannot be followed. For example, one note says do X and another says never " +
  "do X. Notes that only differ, or that add detail to each other, are not " +
  "conflicts. You do not decide which note is right. Reply with ONE JSON object " +
  "and no other text, in this shape: " +
  '{"conflicts":[{"ids":["<id>","<id>"],"question":"<one plain sentence asking ' +
  'the owner which note is right>","confidence":0.0,"rationale":"<short reason>"}]}. ' +
  "Confidence is a number from 0 to 1 for how sure you are that the notes " +
  "conflict. Use the exact ids given. If nothing conflicts, reply " +
  '{"conflicts":[]}.';

interface Conflict {
  confidence: number;
  ids: string[];
  question: string;
}

interface Resolution {
  changes: DreamPlanChange[];
  /** The ids this conflict uses up. A later conflict that names one of them is skipped. */
  claimed: string[];
}

/** The conflicts in a judge answer that name at least two notes of the group. */
const readConflicts = (
  answer: Record<string, unknown>,
  group: readonly MemoryNote[]
): Conflict[] => {
  if (!Array.isArray(answer.conflicts)) {
    return [];
  }
  const valid = new Set(group.map((note) => note.id));
  const conflicts: Conflict[] = [];
  for (const raw of answer.conflicts) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const ids = idsFrom(entry.ids, valid);
    if (ids.length < 2) {
      continue;
    }
    conflicts.push({
      confidence: clampConfidence(entry.confidence),
      ids,
      question: oneLine(entry.question) ?? FALLBACK_QUESTION,
    });
  }
  return conflicts;
};

/** The one note strictly newer than every other member, or null when the newest date is shared. */
const strictlyNewest = (members: readonly MemoryNote[]): MemoryNote | null => {
  const latestDate = members.reduce(
    (latest, note) => (note.date > latest ? note.date : latest),
    ""
  );
  const atLatest = members.filter((note) => note.date === latestDate);
  return atLatest.length === 1 ? (atLatest[0] ?? null) : null;
};

/**
 * The code rule that settles a conflict. A strictly newest person note, at or
 * above the confidence floor, wins: the others are dropped. Anything else is a
 * question for the owner.
 */
const resolveConflict = (
  members: readonly MemoryNote[],
  conflict: Conflict
): Resolution => {
  const newest = strictlyNewest(members);
  if (
    newest !== null &&
    newest.writtenBy === "person" &&
    conflict.confidence >= AUTO_APPLY_FLOOR
  ) {
    const losers = members
      .filter((note) => note.id !== newest.id)
      .map((note) => note.id);
    return {
      changes: losers.map(
        (noteId): DreamPlanChange => ({
          action: "drop",
          noteId,
          reason: PERSON_WINS_REASON,
        })
      ),
      claimed: losers,
    };
  }
  return {
    changes: [
      {
        action: "question",
        noteIds: conflict.ids,
        question: conflict.question,
      },
    ],
    claimed: conflict.ids,
  };
};

/** One judge call for one group, and the changes its conflicts resolve to. */
const reconcileGroup = async (
  judge: Judge,
  group: readonly MemoryNote[]
): Promise<DreamPlanChange[]> => {
  const answer = await askJudge(
    judge,
    group.map((note) => renderNote(note.id, note)).join("\n"),
    RECONCILE_SYSTEM
  );
  if (answer === null) {
    return [];
  }
  const claimed = new Set<string>();
  const changes: DreamPlanChange[] = [];
  for (const conflict of readConflicts(answer, group)) {
    if (conflict.ids.some((id) => claimed.has(id))) {
      continue;
    }
    const members = group.filter((note) => conflict.ids.includes(note.id));
    if (!hasFreshEvidence(members)) {
      continue;
    }
    const resolution = resolveConflict(members, conflict);
    for (const id of resolution.claimed) {
      claimed.add(id);
    }
    changes.push(...resolution.changes);
  }
  return changes;
};

/**
 * Finds notes that disagree, one judge call per group of one kind and scope
 * that holds at least one fresh note. A dropped note leaves `notes`; a questioned
 * note stays.
 */
export const reconcileNotes = async ({
  judge,
  notes,
}: ReconcileInput): Promise<ReconcileResult> => {
  const groups = scopeGroups(notes).filter(
    (group) => group.length >= 2 && hasFreshEvidence(group)
  );
  const changes = (
    await Promise.all(groups.map((group) => reconcileGroup(judge, group)))
  ).flat();
  const dropped = new Set(
    changes.flatMap((change) =>
      change.action === "drop" ? [change.noteId] : []
    )
  );
  const held = changes.flatMap((change) =>
    change.action === "question" ? change.noteIds : []
  );
  return {
    changes,
    held,
    notes: notes.filter((note) => !dropped.has(note.id)),
  };
};
