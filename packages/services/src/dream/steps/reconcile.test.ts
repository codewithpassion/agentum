// Written for reconcile.ts. The Brain has no unit test for the contradiction
// rules as notes, so these cases follow its contradiction and dream canary
// cases: a contradiction is filed for a person, a dream-written note never
// settles a conflict, and a null or garbage judge answer changes nothing.
import { expect, test } from "bun:test";
import type { MemoryNote } from "@repo/db/shared";
import type { Judge } from "./judge.ts";
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

interface Call {
  prompt: string;
  system: string;
}

const fakeJudge = (reply: (prompt: string, call: number) => string | null) => {
  const calls: Call[] = [];
  const judge: Judge = (prompt, system) => {
    calls.push({ prompt, system });
    return Promise.resolve(reply(prompt, calls.length));
  };
  return { calls, judge };
};

const verdict = (...conflicts: unknown[]): string =>
  JSON.stringify({ conflicts });

const PERSON_WINS = "A newer note from a person says otherwise";

test("person beats agent", async () => {
  const older = note("n1", { date: "2026-11-01", text: "Always ask first." });
  const newer = note("n2", {
    date: "2026-11-10",
    text: "Never ask first.",
    writtenBy: "person",
  });
  const { calls, judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [older, newer] });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain(
    "- id=n1 (by agent, 2026-11-01): Always ask first."
  );
  expect(calls[0]?.prompt).toContain(
    "- id=n2 (by person, 2026-11-10): Never ask first."
  );
  expect(result.changes).toEqual([
    { action: "drop", noteId: "n1", reason: PERSON_WINS },
  ]);
  expect(result.notes).toEqual([newer]);
});

test("unclear conflict becomes a question", async () => {
  const older = note("n1", { date: "2026-11-01", writtenBy: "person" });
  const newer = note("n2", { date: "2026-11-10", writtenBy: "agent" });
  const { judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [older, newer] });
  expect(result.changes).toEqual([
    { action: "question", noteIds: ["n1", "n2"], question: "Which is right?" },
  ]);
  expect(result.notes).toEqual([older, newer]);
});

test("a same-date conflict is a question", async () => {
  const a = note("n1", { date: "2026-11-10", writtenBy: "person" });
  const b = note("n2", { date: "2026-11-10", writtenBy: "person" });
  const { judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [a, b] });
  expect(result.changes).toEqual([
    { action: "question", noteIds: ["n1", "n2"], question: "Which is right?" },
  ]);
  expect(result.notes).toEqual([a, b]);
});

test("a low-confidence conflict is a question", async () => {
  const older = note("n1", { date: "2026-11-01", writtenBy: "agent" });
  const newer = note("n2", { date: "2026-11-10", writtenBy: "person" });
  const { judge } = fakeJudge(() =>
    verdict({ confidence: 0.5, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [older, newer] });
  expect(result.changes).toEqual([
    { action: "question", noteIds: ["n1", "n2"], question: "Which is right?" },
  ]);
  expect(result.notes).toEqual([older, newer]);
});

test("a missing question text gets the fallback question", async () => {
  const older = note("n1", { date: "2026-11-01", writtenBy: "person" });
  const newer = note("n2", { date: "2026-11-10", writtenBy: "agent" });
  const { judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"] })
  );
  const result = await reconcileNotes({ judge, notes: [older, newer] });
  expect(result.changes).toEqual([
    {
      action: "question",
      noteIds: ["n1", "n2"],
      question: "These notes disagree. Which one is right?",
    },
  ]);
});

test("a dream-written note never wins", async () => {
  const older = note("n1", { date: "2026-11-01", writtenBy: "person" });
  const newer = note("n2", { date: "2026-11-10", writtenBy: "dream" });
  const { judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [older, newer] });
  expect(result.changes).toEqual([
    { action: "question", noteIds: ["n1", "n2"], question: "Which is right?" },
  ]);
  expect(result.notes).toEqual([older, newer]);
});

test("two dream-written notes in conflict give no judge call at all", async () => {
  const a = note("n1", { date: "2026-11-01", writtenBy: "dream" });
  const b = note("n2", { date: "2026-11-10", writtenBy: "dream" });
  const { calls, judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes: [a, b] });
  expect(calls).toHaveLength(0);
  expect(result).toEqual({ changes: [], held: [], notes: [a, b] });
});

test("a lone note is never sent to the judge", async () => {
  const { calls, judge } = fakeJudge(() => verdict());
  const result = await reconcileNotes({
    judge,
    notes: [note("n1", { writtenBy: "person" })],
  });
  expect(calls).toHaveLength(0);
  expect(result.changes).toEqual([]);
});

test("never mixes kinds or scopes", async () => {
  const people = [
    note("n1", { date: "2026-11-01" }),
    note("n2", { date: "2026-11-02", writtenBy: "person" }),
  ];
  const work = [
    note("n3", { date: "2026-11-01", kind: "work" }),
    note("n4", { date: "2026-11-10", kind: "work", writtenBy: "person" }),
  ];
  const privateOne = [
    note("n5", { date: "2026-11-01", userScope: "user_1" }),
    note("n6", {
      date: "2026-11-10",
      userScope: "user_1",
      writtenBy: "person",
    }),
  ];
  const privateTwo = [
    note("n7", { date: "2026-11-01", userScope: "user_2" }),
    note("n8", {
      date: "2026-11-10",
      userScope: "user_2",
      writtenBy: "person",
    }),
  ];
  const notes = [...people, ...work, ...privateOne, ...privateTwo];
  // The judge names a note from another group. That id is ignored, so the
  // conflict has fewer than two valid ids and nothing changes.
  const { calls, judge } = fakeJudge(() =>
    verdict({ confidence: 0.9, ids: ["n1", "n3"], question: "Which is right?" })
  );
  const result = await reconcileNotes({ judge, notes });
  expect(calls).toHaveLength(4);
  expect(calls[0]?.prompt).toContain("id=n1");
  expect(calls[0]?.prompt).not.toContain("id=n3");
  expect(calls[1]?.prompt).toContain("id=n3");
  expect(calls[1]?.prompt).not.toContain("id=n1");
  expect(calls[2]?.prompt).not.toContain("id=n7");
  expect(calls[3]?.prompt).not.toContain("id=n5");
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual(notes);
});

test("a null, garbage or thrown answer changes nothing", async () => {
  const older = note("n1", { date: "2026-11-01", writtenBy: "agent" });
  const newer = note("n2", { date: "2026-11-10", writtenBy: "person" });
  const notes = [older, newer];
  const answers: Judge[] = [
    () => Promise.resolve(null),
    () => Promise.resolve("no json here"),
    () => Promise.resolve("[1,2]"),
    () => Promise.reject(new Error("model down")),
  ];
  const results = await Promise.all(
    answers.map((judge) => reconcileNotes({ judge, notes }))
  );
  for (const result of results) {
    expect(result).toEqual({ changes: [], held: [], notes });
  }
});

test("three-way conflict: a strictly newest person note drops the other two", async () => {
  const a = note("n1", { date: "2026-10-01", writtenBy: "agent" });
  const b = note("n2", { date: "2026-10-02", writtenBy: "agent" });
  const c = note("n3", { date: "2026-11-01", writtenBy: "person" });
  const { judge } = fakeJudge(() =>
    verdict({
      confidence: 0.9,
      ids: ["n1", "n2", "n3"],
      question: "Which is right?",
    })
  );
  const result = await reconcileNotes({ judge, notes: [a, b, c] });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "n1", reason: PERSON_WINS },
    { action: "drop", noteId: "n2", reason: PERSON_WINS },
  ]);
  expect(result.notes).toEqual([c]);
});

test("three-way conflict without a strictly newest note is one question", async () => {
  const a = note("n1", { date: "2026-10-01", writtenBy: "agent" });
  const b = note("n2", { date: "2026-10-02", writtenBy: "agent" });
  const c = note("n3", { date: "2026-10-02", writtenBy: "person" });
  const { judge } = fakeJudge(() =>
    verdict({
      confidence: 0.9,
      ids: ["n1", "n2", "n3"],
      question: "Which is right?",
    })
  );
  const result = await reconcileNotes({ judge, notes: [a, b, c] });
  expect(result.changes).toEqual([
    {
      action: "question",
      noteIds: ["n1", "n2", "n3"],
      question: "Which is right?",
    },
  ]);
  expect(result.notes).toEqual([a, b, c]);
});

test("a note is never named twice", async () => {
  const n1 = note("n1", { date: "2026-10-01", writtenBy: "agent" });
  const n2 = note("n2", { date: "2026-11-10", writtenBy: "person" });
  const n3 = note("n3", { date: "2026-11-05", writtenBy: "agent" });
  const { judge } = fakeJudge(() =>
    verdict(
      { confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" },
      { confidence: 0.9, ids: ["n1", "n3"], question: "Or this one?" }
    )
  );
  const result = await reconcileNotes({ judge, notes: [n1, n2, n3] });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "n1", reason: PERSON_WINS },
  ]);
  expect(result.notes).toEqual([n2, n3]);
});

test("result.notes drops dropped notes and keeps questioned ones", async () => {
  const n1 = note("n1", { date: "2026-10-01", writtenBy: "agent" });
  const n2 = note("n2", { date: "2026-11-10", writtenBy: "person" });
  const n3 = note("n3", { date: "2026-11-05", writtenBy: "agent" });
  const n4 = note("n4", { date: "2026-10-01", writtenBy: "person" });
  const { judge } = fakeJudge(() =>
    verdict(
      { confidence: 0.9, ids: ["n1", "n2"], question: "Which is right?" },
      { confidence: 0.9, ids: ["n3", "n4"], question: "Or this one?" }
    )
  );
  const result = await reconcileNotes({ judge, notes: [n1, n3, n2, n4] });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "n1", reason: PERSON_WINS },
    { action: "question", noteIds: ["n3", "n4"], question: "Or this one?" },
  ]);
  expect(result.notes).toEqual([n3, n2, n4]);
});
