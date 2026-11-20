import {
  MEMORY_NOTE_KINDS,
  type MemoryChange,
  type MemoryChangeAction,
  type MemoryNote,
  type MemoryNoteKind,
  type MemorySourceKind,
  type MemoryWriter,
} from "@repo/db/shared";

export const KIND_LABELS: Record<MemoryNoteKind, string> = {
  corrections: "Corrections",
  people: "About people",
  places: "Where things are",
  work: "Work in progress",
};

export interface NoteGroup {
  held: MemoryChange[];
  kind: MemoryNoteKind;
  label: string;
  notes: MemoryNote[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A merge row, or a row a merge wrote. The service decides and undoes those with their dream, so the Knows tab shows no Approve, Reject or Undo for them. */
export function isMergeRow(
  change: Pick<MemoryChange, "action" | "groupId">
): boolean {
  return change.action === "merge" || change.groupId !== null;
}

function byNoteDateDesc(
  a: { note: MemoryNote; index: number },
  b: { note: MemoryNote; index: number }
): number {
  if (a.note.date !== b.note.date) {
    return a.note.date < b.note.date ? 1 : -1;
  }
  return b.index - a.index;
}

function byCreatedAtDesc(a: MemoryChange, b: MemoryChange): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function notesOfKind(
  notes: readonly MemoryNote[],
  kind: MemoryNoteKind
): MemoryNote[] {
  return notes
    .map((note, index) => ({ index, note }))
    .filter((entry) => entry.note.kind === kind)
    .sort(byNoteDateDesc)
    .map((entry) => entry.note);
}

function heldOfKind(
  changes: readonly MemoryChange[],
  kind: MemoryNoteKind
): MemoryChange[] {
  return changes
    .filter(
      (change) =>
        change.status === "held" && change.kind === kind && !isMergeRow(change)
    )
    .sort(byCreatedAtDesc);
}

/** One group per kind that has a note or a held change, in MEMORY_NOTE_KINDS order. `held` keeps only changes with status "held", each in its own kind's group, newest createdAt first. Notes are newest date first; notes with the same date keep the later input position first. Never mutates its inputs. */
export function groupNotes(
  notes: readonly MemoryNote[],
  held: readonly MemoryChange[]
): NoteGroup[] {
  const groups: NoteGroup[] = [];
  for (const kind of MEMORY_NOTE_KINDS) {
    const kindNotes = notesOfKind(notes, kind);
    const kindHeld = heldOfKind(held, kind);
    if (kindNotes.length === 0 && kindHeld.length === 0) {
      continue;
    }
    groups.push({
      held: kindHeld,
      kind,
      label: KIND_LABELS[kind],
      notes: kindNotes,
    });
  }
  return groups;
}

/** "2026-11-11" -> "11 Nov". Anything that is not YYYY-MM-DD comes back unchanged. */
export function formatNoteDate(date: string): string {
  const match = ISO_DATE.exec(date);
  if (match === null) {
    return date;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!isRealDate) {
    return date;
  }
  return `${day} ${MONTH_NAMES[month - 1]}`;
}

export const SOURCE_LABELS: Record<MemorySourceKind, string> = {
  request: "a request",
  run: "a task",
  session: "a conversation",
};

const NOTE_LEADS: Record<
  MemoryWriter,
  { withSource: string; withoutSource: string }
> = {
  agent: { withoutSource: "Noted by the agent", withSource: "Noticed in" },
  dream: {
    withoutSource: "Found in a dream",
    withSource: "Found in a dream from",
  },
  person: { withoutSource: "Added by hand", withSource: "Saved from" },
};

/** What a note row says before its source link: person+source "Saved from", person+no source "Added by hand", agent+source "Noticed in", agent+no source "Noted by the agent", dream+source "Found in a dream from", dream+no source "Found in a dream". */
export function noteLead(
  note: Pick<MemoryNote, "source" | "writtenBy">
): string {
  const lead = NOTE_LEADS[note.writtenBy];
  return note.source === null ? lead.withoutSource : lead.withSource;
}

const HELD_LEADS: Record<MemoryChangeAction, string> = {
  add: "Wants to remember",
  edit: "Wants to change a note to",
  forget: "Wants to forget",
  merge: "Wants to merge notes into",
};

/** A held change's heading: add "Wants to remember", edit "Wants to change a note to", forget "Wants to forget", merge "Wants to merge notes into". */
export function heldLead(action: MemoryChangeAction): string {
  return HELD_LEADS[action];
}
