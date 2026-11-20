// Ported from the-brain dream.canary.test.ts case (e): dream-generated facts
// are never re-selected, so dream output is not evidence for the next dream.
// Here the marker is `written_by: dream`, and the rule is tested through every
// step. The chain test checks that the steps run one after another never name
// a note twice.
import { expect, test } from "bun:test";
import type { MemoryNote } from "@repo/db/shared";
import { hasFreshEvidence, isFreshEvidence } from "./evidence.ts";
import type { Judge } from "./judge.ts";
import { mergeNotes } from "./merge.ts";
import { pruneNotes } from "./prune.ts";
import { reconcileNotes } from "./reconcile.ts";

const note = (id: string, overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  date: "2026-11-02",
  id,
  kind: "people",
  source: null,
  text: `text of ${id}`,
  userScope: null,
  writtenBy: "agent",
  ...overrides,
});

const fakeJudge = (answers: unknown[]) => {
  const calls: string[] = [];
  const judge: Judge = (prompt) => {
    calls.push(prompt);
    const answer = answers[calls.length - 1];
    return Promise.resolve(
      answer === undefined ? null : JSON.stringify(answer)
    );
  };
  return { calls, judge };
};

test("only a note a dream wrote is not fresh evidence", () => {
  expect(isFreshEvidence(note("a", { writtenBy: "person" }))).toBe(true);
  expect(isFreshEvidence(note("a", { writtenBy: "agent" }))).toBe(true);
  expect(isFreshEvidence(note("a", { writtenBy: "dream" }))).toBe(false);
  expect(hasFreshEvidence([note("a", { writtenBy: "dream" }), note("b")])).toBe(
    true
  );
  expect(hasFreshEvidence([note("a", { writtenBy: "dream" })])).toBe(false);
});

test("merge never merges dream-written notes with each other", async () => {
  const { calls, judge } = fakeJudge([]);
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("a", { text: "Mia wants docs", writtenBy: "dream" }),
      note("b", { text: "Mia wants docs", writtenBy: "dream" }),
      note("c", { text: "Mia likes docs a lot", writtenBy: "dream" }),
    ],
    today: "2026-11-20",
  });
  expect(calls).toHaveLength(0);
  expect(result.changes).toEqual([]);
});

test("a dream-written note can be merged into a note a person wrote, which stays", async () => {
  const { judge } = fakeJudge([
    { groups: [{ confidence: 0.9, ids: ["a", "b"], text: "Mia wants docs" }] },
  ]);
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("a", {
        date: "2026-11-10",
        text: "Mia wants docs",
        writtenBy: "dream",
      }),
      note("b", {
        date: "2026-11-12",
        text: "Mia likes docs",
        writtenBy: "person",
      }),
    ],
    today: "2026-11-20",
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["a"],
      action: "merge",
      keepNoteId: "b",
      text: "Mia wants docs",
    },
  ]);
});

test("reconcile never lets a dream-written note win over a person's note", async () => {
  const { judge } = fakeJudge([
    {
      conflicts: [
        { confidence: 0.95, ids: ["old", "new"], question: "Docs or PDFs?" },
      ],
    },
  ]);
  const result = await reconcileNotes({
    judge,
    notes: [
      note("old", { date: "2026-10-01", writtenBy: "person" }),
      note("new", { date: "2026-11-15", writtenBy: "dream" }),
    ],
  });
  expect(result.changes).toEqual([
    { action: "question", noteIds: ["old", "new"], question: "Docs or PDFs?" },
  ]);
});

test("reconcile skips notes that only dreams wrote", async () => {
  const { calls, judge } = fakeJudge([]);
  const result = await reconcileNotes({
    judge,
    notes: [
      note("a", { writtenBy: "dream" }),
      note("b", { writtenBy: "dream" }),
    ],
  });
  expect(calls).toHaveLength(0);
  expect(result.changes).toEqual([]);
});

test("the steps run in turn never name a note twice", async () => {
  const notes = [
    note("a", {
      date: "2026-10-01",
      text: "Mia wants docs",
      writtenBy: "person",
    }),
    note("b", { date: "2026-10-02", text: "Mia wants docs please" }),
    note("c", {
      date: "2026-10-03",
      text: "Tom wants PDFs",
      writtenBy: "agent",
    }),
    note("d", {
      date: "2026-11-10",
      text: "Tom wants docs",
      writtenBy: "person",
    }),
    note("e", { date: "2026-01-01", text: "Old note" }),
  ];
  const merged = await mergeNotes({
    candidates: [],
    judge: fakeJudge([
      {
        groups: [{ confidence: 0.9, ids: ["a", "b"], text: "Mia wants docs" }],
      },
    ]).judge,
    notes,
    today: "2026-11-20",
  });
  const reconciled = await reconcileNotes({
    judge: fakeJudge([
      { conflicts: [{ confidence: 0.9, ids: ["c", "d"], question: "?" }] },
    ]).judge,
    notes: merged.notes,
  });
  const pruned = await pruneNotes({
    held: reconciled.held,
    judge: fakeJudge([]).judge,
    maxChars: 6000,
    notes: reconciled.notes,
    today: "2026-11-20",
  });
  const named: string[] = [];
  for (const change of [
    ...merged.changes,
    ...reconciled.changes,
    ...pruned.changes,
  ]) {
    if (change.action === "merge") {
      named.push(change.keepNoteId, ...change.absorbedNoteIds);
    } else if (change.action === "drop") {
      named.push(change.noteId);
    }
  }
  expect(named.toSorted()).toEqual(["a", "b", "c", "e"]);
  expect(new Set(named).size).toBe(named.length);
  expect(pruned.notes.map((n) => n.id)).toEqual(["a", "d"]);
});

test("a person's note is not folded into an agent's note after an exact duplicate fold", async () => {
  const result = await mergeNotes({
    candidates: [],
    judge: fakeJudge([
      {
        groups: [{ confidence: 0.9, ids: ["a", "c"], text: "Mia wants docs" }],
      },
    ]).judge,
    notes: [
      note("a", {
        date: "2026-10-05",
        text: "Mia wants docs",
        writtenBy: "person",
      }),
      note("b", { date: "2026-10-01", text: "Mia wants docs" }),
      note("c", { date: "2026-10-02", text: "Mia likes docs" }),
    ],
    today: "2026-11-20",
  });
  expect(
    result.changes.map((c) => c.action === "merge" && c.keepNoteId)
  ).toEqual(["a", "a"]);
});

test("a note a question waits on is never dropped or merged by prune", async () => {
  const stale = note("old", { date: "2026-01-01", writtenBy: "person" });
  const fresh = note("new", { date: "2026-11-15", writtenBy: "agent" });
  const { calls, judge } = fakeJudge([]);
  const result = await pruneNotes({
    held: ["old", "new"],
    judge,
    maxChars: 1,
    notes: [stale, fresh],
    today: "2026-11-20",
  });
  expect(calls).toHaveLength(0);
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual([stale, fresh]);
});

test("reconcile reports the notes a question holds", async () => {
  const { judge } = fakeJudge([
    { conflicts: [{ confidence: 0.9, ids: ["a", "b"], question: "Which?" }] },
  ]);
  const result = await reconcileNotes({
    judge,
    notes: [
      note("a", { date: "2026-11-02" }),
      note("b", { date: "2026-11-03" }),
    ],
  });
  expect(result.held).toEqual(["a", "b"]);
});
