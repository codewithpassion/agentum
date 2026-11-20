import { expect, test } from "bun:test";
import type { MemoryChange, MemoryNote } from "@repo/db/shared";
import {
  formatNoteDate,
  groupNotes,
  heldLead,
  KIND_LABELS,
  noteLead,
  SOURCE_LABELS,
} from "./notes-logic.ts";

function note(
  overrides: Partial<MemoryNote> & Pick<MemoryNote, "id">
): MemoryNote {
  return {
    date: "2026-11-10",
    kind: "people",
    source: null,
    text: `note ${overrides.id}`,
    userScope: null,
    writtenBy: "person",
    ...overrides,
  };
}

function change(
  overrides: Partial<MemoryChange> & Pick<MemoryChange, "id">
): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: "2026-11-10T09:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    dreamRunId: null,
    groupId: null,
    kind: "people",
    libraryVersionId: null,
    noteId: `note-${overrides.id}`,
    source: null,
    status: "held",
    text: `change ${overrides.id}`,
    userScope: null,
    writtenBy: "agent",
    ...overrides,
  };
}

test("groupNotes orders groups by kind and keeps only kinds with content", () => {
  const groups = groupNotes(
    [note({ id: "w", kind: "work" }), note({ id: "p", kind: "people" })],
    []
  );
  expect(groups.map((group) => group.kind)).toEqual(["people", "work"]);
  expect(groups.map((group) => group.label)).toEqual([
    "About people",
    "Work in progress",
  ]);
});

test("groupNotes puts a held change only in its own kind group", () => {
  const groups = groupNotes(
    [],
    [change({ id: "c1", kind: "places" }), change({ id: "c2", kind: "work" })]
  );
  expect(groups.map((group) => group.kind)).toEqual(["work", "places"]);
  expect(groups.map((group) => group.held.map((row) => row.id))).toEqual([
    ["c2"],
    ["c1"],
  ]);
  expect(groups.map((group) => group.notes)).toEqual([[], []]);
});

test("groupNotes counts only held changes", () => {
  const groups = groupNotes(
    [],
    [
      change({ id: "applied", status: "applied" }),
      change({ id: "rejected", status: "rejected" }),
      change({ id: "undone", status: "undone" }),
      change({ id: "held", status: "held" }),
    ]
  );
  expect(groups).toHaveLength(1);
  expect(groups.map((group) => group.held.map((row) => row.id))).toEqual([
    ["held"],
  ]);
});

test("groupNotes leaves out a kind whose only changes are not held", () => {
  const groups = groupNotes(
    [],
    [change({ id: "applied", kind: "corrections", status: "applied" })]
  );
  expect(groups).toEqual([]);
});

test("groupNotes sorts held changes newest createdAt first", () => {
  const groups = groupNotes(
    [],
    [
      change({ createdAt: "2026-11-01T08:00:00.000Z", id: "old" }),
      change({ createdAt: "2026-11-12T08:00:00.000Z", id: "new" }),
      change({ createdAt: "2026-11-05T08:00:00.000Z", id: "mid" }),
    ]
  );
  expect(groups.map((group) => group.held.map((row) => row.id))).toEqual([
    ["new", "mid", "old"],
  ]);
});

test("groupNotes sorts notes newest date first", () => {
  const groups = groupNotes(
    [
      note({ date: "2026-10-01", id: "oldest" }),
      note({ date: "2026-11-12", id: "newest" }),
      note({ date: "2026-11-01", id: "middle" }),
    ],
    []
  );
  expect(groups.map((group) => group.notes.map((row) => row.id))).toEqual([
    ["newest", "middle", "oldest"],
  ]);
});

test("groupNotes puts the later input position first for notes on the same date", () => {
  const groups = groupNotes(
    [
      note({ date: "2026-11-10", id: "first" }),
      note({ date: "2026-11-11", id: "later-day" }),
      note({ date: "2026-11-10", id: "second" }),
      note({ date: "2026-11-10", id: "third" }),
    ],
    []
  );
  expect(groups.map((group) => group.notes.map((row) => row.id))).toEqual([
    ["later-day", "third", "second", "first"],
  ]);
});

test("groupNotes does not mutate its inputs", () => {
  const notes = [
    note({ date: "2026-10-01", id: "a" }),
    note({ date: "2026-11-01", id: "b" }),
  ];
  const changes = [
    change({ createdAt: "2026-11-01T08:00:00.000Z", id: "x" }),
    change({ createdAt: "2026-11-02T08:00:00.000Z", id: "y" }),
  ];
  const notesBefore = notes.map((row) => row.id);
  const changesBefore = changes.map((row) => row.id);
  groupNotes(notes, changes);
  expect(notes.map((row) => row.id)).toEqual(notesBefore);
  expect(changes.map((row) => row.id)).toEqual(changesBefore);
});

test("formatNoteDate turns a valid date into day and short month", () => {
  expect(formatNoteDate("2026-11-11")).toBe("11 Nov");
  expect(formatNoteDate("2026-01-05")).toBe("5 Jan");
  expect(formatNoteDate("2028-02-29")).toBe("29 Feb");
});

test("formatNoteDate returns anything that is not a real YYYY-MM-DD date unchanged", () => {
  expect(formatNoteDate("11/11/2026")).toBe("11/11/2026");
  expect(formatNoteDate("2026-11-11T00:00:00Z")).toBe("2026-11-11T00:00:00Z");
  expect(formatNoteDate("2026-13-01")).toBe("2026-13-01");
  expect(formatNoteDate("2026-02-30")).toBe("2026-02-30");
  expect(formatNoteDate("")).toBe("");
});

test("SOURCE_LABELS names each source kind", () => {
  expect(SOURCE_LABELS).toEqual({
    request: "a request",
    run: "a task",
    session: "a conversation",
  });
});

test("noteLead covers all six writer and source cases", () => {
  const source = { id: "s1", kind: "session" as const };
  expect(noteLead({ source, writtenBy: "person" })).toBe("Saved from");
  expect(noteLead({ source: null, writtenBy: "person" })).toBe("Added by hand");
  expect(noteLead({ source, writtenBy: "agent" })).toBe("Noticed in");
  expect(noteLead({ source: null, writtenBy: "agent" })).toBe(
    "Noted by the agent"
  );
  expect(noteLead({ source, writtenBy: "dream" })).toBe(
    "Found in a dream from"
  );
  expect(noteLead({ source: null, writtenBy: "dream" })).toBe(
    "Found in a dream"
  );
});

test("heldLead covers all four actions", () => {
  expect(heldLead("add")).toBe("Wants to remember");
  expect(heldLead("edit")).toBe("Wants to change a note to");
  expect(heldLead("forget")).toBe("Wants to forget");
  expect(heldLead("merge")).toBe("Wants to merge notes into");
});

test("KIND_LABELS names each note kind", () => {
  expect(KIND_LABELS).toEqual({
    corrections: "Corrections",
    people: "About people",
    places: "Where things are",
    work: "Work in progress",
  });
});

test("groupNotes leaves out held merge rows, which are decided with their dream", () => {
  const groups = groupNotes(
    [],
    [
      change({ action: "merge", id: "m1" }),
      change({ action: "forget", groupId: "m1", id: "f1" }),
      change({ id: "plain" }),
    ]
  );
  expect(groups.flatMap((group) => group.held.map((row) => row.id))).toEqual([
    "plain",
  ]);
});
