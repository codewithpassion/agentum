// A dream's plan as `memory_changes` rows, and those rows as file changes.
// Held rows are the plan between the night it was made and the morning a
// person approves it, so the same two functions serve a plan applied at once
// and a plan applied later. A merge is one `merge` row and a `forget` row for
// each note it absorbed, sharing a `group_id` (docs/v4/memory-format.md). A
// merge that absorbs nothing is an edit in place, and one whose text equals
// the keeper's leaves the keeper's writer and date alone (DR.2).
import type { memoryChanges } from "@repo/db/schema/memory";
import type { DreamPlan, DreamPlanChange, MemoryNote } from "@repo/db/shared";
import { monotonicFactory } from "ulidx";
import {
  apply,
  type MemoryFileChange,
  type MemoryFiles,
  parseMemoryFile,
} from "../memory/codec.ts";
import { pathOfNote } from "../memory/files.ts";

type Row = typeof memoryChanges.$inferInsert;

/** Ids that sort in the order they were made, so rows replay in plan order. */
const nextId = monotonicFactory();

export interface PlanContext {
  agentId: string;
  /** `now` as ISO. */
  createdAt: string;
  /** The notes the plan was made against, by id. */
  notes: ReadonlyMap<string, MemoryNote>;
  runId: string;
  status: "applied" | "held";
  workspaceId: string;
}

const base = (ctx: PlanContext) =>
  ({
    agentId: ctx.agentId,
    createdAt: ctx.createdAt,
    decidedAt: null,
    decidedBy: null,
    dreamRunId: ctx.runId,
    libraryVersionId: null,
    status: ctx.status,
    teamId: null,
    workspaceId: ctx.workspaceId,
    writtenBy: "dream",
  }) as const;

const sourceColumns = (source: MemoryNote["source"]) => ({
  sourceId: source?.id ?? null,
  sourceKind: source?.kind ?? null,
});

type Change<A extends DreamPlanChange["action"]> = Extract<
  DreamPlanChange,
  { action: A }
>;

const forgetRow = (
  note: MemoryNote,
  ctx: PlanContext,
  groupId: string | null
): Row => ({
  ...base(ctx),
  ...sourceColumns(note.source),
  action: "forget",
  groupId,
  id: nextId(),
  kind: note.kind,
  noteId: note.id,
  text: note.text,
  userScope: note.userScope,
});

const addRows = (change: Change<"add">, ctx: PlanContext): Row[] => [
  {
    ...base(ctx),
    ...sourceColumns(change.source),
    action: "add",
    id: nextId(),
    kind: change.kind,
    noteId: change.noteId ?? nextId(),
    text: change.text,
    userScope: change.userScope,
  },
];

const dropRows = (change: Change<"drop">, ctx: PlanContext): Row[] => {
  const note = ctx.notes.get(change.noteId);
  return note ? [forgetRow(note, ctx, null)] : [];
};

const mergeRows = (change: Change<"merge">, ctx: PlanContext): Row[] => {
  const keeper = ctx.notes.get(change.keepNoteId);
  if (!keeper) {
    return [];
  }
  const absorbed = change.absorbedNoteIds.flatMap(
    (noteId) => ctx.notes.get(noteId) ?? []
  );
  if (absorbed.length === 0 && change.text === keeper.text) {
    return [];
  }
  const groupId = nextId();
  const edits = absorbed.length === 0;
  return [
    {
      ...base(ctx),
      ...sourceColumns(keeper.source),
      action: edits ? "edit" : "merge",
      groupId: edits ? null : groupId,
      id: groupId,
      kind: keeper.kind,
      noteId: keeper.id,
      text: change.text,
      userScope: keeper.userScope,
    },
    ...absorbed.map((note) => forgetRow(note, ctx, groupId)),
  ];
};

/** The rows a plan writes, in plan order. A question writes none: it is a `dream_questions` row. */
export const rowsFromPlan = (plan: DreamPlan, ctx: PlanContext): Row[] =>
  plan.flatMap((change) => {
    if (change.action === "add") {
      return addRows(change, ctx);
    }
    if (change.action === "drop") {
      return dropRows(change, ctx);
    }
    return change.action === "merge" ? mergeRows(change, ctx) : [];
  });

type RowLike = Pick<
  Row,
  | "action"
  | "groupId"
  | "id"
  | "kind"
  | "noteId"
  | "sourceId"
  | "sourceKind"
  | "text"
  | "userScope"
>;

const notesIn = (files: MemoryFiles): Map<string, MemoryNote> => {
  const notes = new Map<string, MemoryNote>();
  for (const [path, text] of Object.entries(files)) {
    const parsed = parseMemoryFile(path, text);
    if (parsed.ok) {
      for (const note of parsed.notes) {
        notes.set(note.id.toUpperCase(), note);
      }
    }
  }
  return notes;
};

const sourceOf = (row: RowLike): MemoryNote["source"] =>
  row.sourceId && row.sourceKind
    ? { id: row.sourceId, kind: row.sourceKind }
    : null;

/** The write a text change makes: the dream's, unless the text stays as it was. */
const editOf = (
  row: RowLike,
  existing: MemoryNote | undefined,
  today: string
) => {
  const same = existing?.text === row.text;
  return {
    date: same && existing ? existing.date : today,
    noteId: row.noteId,
    text: row.text,
    writtenBy: same && existing ? existing.writtenBy : ("dream" as const),
  };
};

/**
 * The files after the rows apply, in row order, on `today`. Throws
 * `MemoryCodecError` when a note a row names is not there, because the files
 * changed since the plan was made.
 */
export const applyRows = (
  files: MemoryFiles,
  rows: readonly RowLike[],
  today: string
): MemoryFiles => {
  const absorbedBy = new Map<string, string[]>();
  for (const row of rows) {
    if (row.action === "forget" && row.groupId) {
      absorbedBy.set(row.groupId, [
        ...(absorbedBy.get(row.groupId) ?? []),
        row.noteId,
      ]);
    }
  }
  let current = files;
  for (const row of rows) {
    // The forget rows of a merge are its absorbed notes.
    if (row.action === "forget" && row.groupId) {
      continue;
    }
    const existing = notesIn(current).get(row.noteId.toUpperCase());
    let change: MemoryFileChange;
    if (row.action === "add") {
      change = {
        action: "add",
        note: {
          date: today,
          id: row.noteId,
          kind: row.kind,
          source: sourceOf(row),
          text: row.text,
          userScope: row.userScope ?? null,
          writtenBy: "dream",
        },
      };
    } else if (row.action === "forget") {
      change = { action: "forget", noteId: row.noteId };
    } else if (row.action === "edit") {
      change = { action: "edit", ...editOf(row, existing, today) };
    } else {
      change = {
        absorbedIds: absorbedBy.get(row.id) ?? [],
        action: "merge",
        ...editOf(row, existing, today),
      };
    }
    current = apply(current, change);
  }
  return current;
};

/** The file a row's note lives in, relative to the memory folder. */
export const pathOfRow = (row: Pick<Row, "kind" | "userScope">): string =>
  pathOfNote({ kind: row.kind, userScope: row.userScope ?? null });
