import type {
  DreamCounts,
  DreamDecision,
  DreamRun,
  DreamRunStatus,
  DreamSchedule,
} from "@repo/db/shared";

export type DreamCardState =
  | { kind: "none" }
  | { kind: "running"; run: DreamRun }
  | { kind: "skipped"; run: DreamRun }
  | { kind: "failed"; run: DreamRun }
  | { kind: "undone"; run: DreamRun }
  | { kind: "held"; run: DreamRun }
  | { kind: "rejected"; run: DreamRun }
  | { kind: "done"; questions: number; run: DreamRun };

const DAY_MS = 86_400_000;
/** Starts before this local hour count as last night. */
const LAST_NIGHT_BEFORE_HOUR = 6;

/** Newest first by start time, ties by id descending. Never mutates. */
export function sortRuns(runs: readonly DreamRun[]): DreamRun[] {
  return [...runs].sort((a, b) => {
    const byStart = Date.parse(b.startedAt) - Date.parse(a.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? 1 : -1;
  });
}

/** What the dream card shows, read from the newest run. */
export function dreamCardState(runs: readonly DreamRun[]): DreamCardState {
  const [newest] = sortRuns(runs);
  if (!newest) {
    return { kind: "none" };
  }
  if (newest.status === "done" && newest.heldChanges > 0) {
    return { kind: "held", run: newest };
  }
  if (wasRejected(newest)) {
    return { kind: "rejected", run: newest };
  }
  if (newest.status === "done") {
    return {
      kind: "done",
      questions: newest.counts.questions,
      run: newest,
    };
  }
  return { kind: newest.status, run: newest };
}

/** Every run but the newest, newest first. */
export function earlierRuns(runs: readonly DreamRun[]): DreamRun[] {
  return sortRuns(runs).slice(1);
}

/** A dream whose held batch the owner rejected: it proposed changes, none are held any more, and it wrote nothing. */
export function wasRejected(run: DreamRun): boolean {
  const { added, dropped, merged } = run.counts;
  return (
    run.status === "done" &&
    run.heldChanges === 0 &&
    run.resultVersion === null &&
    added + dropped + merged > 0
  );
}

/** The diary line for what a dream changed. Questions are left out. */
export function countsSentence(counts: DreamCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) {
    parts.push(
      `added ${counts.added} ${counts.added === 1 ? "note" : "notes"}`
    );
  }
  if (counts.merged > 0) {
    parts.push(`merged ${counts.merged}`);
  }
  if (counts.dropped > 0) {
    parts.push(`dropped ${counts.dropped}`);
  }
  if (parts.length === 0) {
    return "Nothing changed.";
  }
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** The line that says the dream asked the owner something, or null when it asked nothing. The count is what the dream asked, so the line stays true after the owner answers. */
export function questionsSentence(questions: number): string | null {
  if (questions === 0) {
    return null;
  }
  if (questions === 1) {
    return "It asked you one question.";
  }
  return `It asked you ${questions} questions.`;
}

/** The calendar day of a moment in the viewer's time zone, as a day count. */
function localDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** The card heading, from the viewer's local days and local hour. */
export function dreamTitle(startedAt: string, nowMs: number): string {
  const start = new Date(startedAt);
  const days = localDay(nowMs) - localDay(start.getTime());
  if (days === 0) {
    return start.getHours() < LAST_NIGHT_BEFORE_HOUR
      ? "Last night's dream"
      : "Today's dream";
  }
  if (days === 1) {
    return "Yesterday's dream";
  }
  return `Dream from ${days} days ago`;
}

/** Only a finished dream that wrote its changes can be undone. A held or rejected batch wrote nothing, so there is nothing to undo. */
export function canUndoRun(run: DreamRun): boolean {
  const { added, dropped, merged } = run.counts;
  return (
    run.status === "done" &&
    run.heldChanges === 0 &&
    run.resultVersion !== null &&
    added + dropped + merged > 0
  );
}

export const RUN_STATUS_LABELS: Record<DreamRunStatus, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  skipped: "Skipped",
  undone: "Undone",
};

export const SCHEDULE_OPTIONS: readonly {
  hint: string;
  label: string;
  value: DreamSchedule;
}[] = [
  {
    hint: "Dreams at 2 in the morning, every day.",
    label: "Nightly",
    value: "nightly",
  },
  {
    hint: "Dreams at 2 in the morning, once a week.",
    label: "Weekly",
    value: "weekly",
  },
  {
    hint: "Never dreams on its own. You can still use Dream now.",
    label: "Off",
    value: "off",
  },
];

/** The decision being sent for a held batch, or null when the card waits for something else. */
export function decisionPending(pending: string | null): DreamDecision | null {
  return pending === "approve" || pending === "reject" ? pending : null;
}
