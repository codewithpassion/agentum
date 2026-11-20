// Ported from the-brain/packages/db/src/dream/hygiene.ts (the age rule: a fact
// unused for a while decays, and a fresh one is spared) and from judge.ts and
// apply.ts (the merge floor). The Brain's hygiene tests check SQL decay, so the
// cases below are written here for notes. The finished-work pass and the size
// budget have no Brain counterpart.
import { expect, test } from "bun:test";
import type { DreamPlan, MemoryNote } from "@repo/db/shared";
import type { Judge } from "./judge.ts";
import { pruneNotes } from "./prune.ts";

const DAY_MS = 86_400_000;
const TODAY = "2026-11-20";

const ago = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const note = (id: string, overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  date: TODAY,
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

/** A judge that answers each call with `respond`, and records every call it gets. */
const fakeJudge = (
  respond: (prompt: string, system: string) => string | null
): { calls: Call[]; judge: Judge } => {
  const calls: Call[] = [];
  const judge: Judge = (prompt, system) => {
    calls.push({ prompt, system });
    return Promise.resolve(respond(prompt, system));
  };
  return { calls, judge };
};

const isFinishedJudge = (system: string): boolean =>
  system.includes("memory-hygiene");

const ID_LABEL = /id=(\S+)/g;

const idsIn = (prompt: string): string[] =>
  [...prompt.matchAll(ID_LABEL)].map((match) => match[1] ?? "");

const noFinished = (): string => JSON.stringify({ finished: [] });

const mergeAnswer = (ids: string[], text: string, confidence = 0.9): string =>
  JSON.stringify({
    groups: [{ confidence, ids, rationale: "same thing", text }],
  });

test("prune by age", async () => {
  const { calls, judge } = fakeJudge(() => null);
  const notes = [
    note("n59", { date: ago(59) }),
    note("n60", { date: ago(60) }),
    note("n61", { date: ago(61) }),
    note("n200", { date: ago(200) }),
    note("bad", { date: "not a date" }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 1_000_000,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "n61", reason: "Not changed for 60 days" },
    { action: "drop", noteId: "n200", reason: "Not changed for 60 days" },
  ]);
  expect(result.notes.map((n) => n.id)).toEqual(["n59", "n60", "bad"]);
  expect(calls).toHaveLength(0);
});

test("prune by age drops dream-written notes too", async () => {
  const { judge } = fakeJudge(() => null);
  const result = await pruneNotes({
    judge,
    maxChars: 1_000_000,
    notes: [note("d1", { date: ago(90), writtenBy: "dream" })],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "d1", reason: "Not changed for 60 days" },
  ]);
});

test("finished work", async () => {
  const { calls, judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? JSON.stringify({
          finished: [
            { confidence: 0.9, id: "w1", rationale: "delivered" },
            { confidence: 0.5, id: "w2", rationale: "maybe" },
            { confidence: 0.99, id: "ghost", rationale: "not shown" },
          ],
        })
      : null
  );
  const notes = [
    note("w1", { kind: "work", text: "Export shipped to the client" }),
    note("w2", { kind: "work", text: "Export waits on legal" }),
    note("p1", { text: "Alex private preference" }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 1_000_000,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "w1", reason: "Work finished" },
  ]);
  expect(result.notes.map((n) => n.id)).toEqual(["w2", "p1"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain("id=w1");
  expect(calls[0]?.prompt).toContain("id=w2");
  expect(calls[0]?.prompt).not.toContain("p1");
  expect(calls[0]?.prompt).not.toContain("Alex private preference");
});

test("finished work can drop a dream-written note", async () => {
  const { judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? JSON.stringify({
          finished: [{ confidence: 0.8, id: "d1", rationale: "closed" }],
        })
      : null
  );
  const result = await pruneNotes({
    judge,
    maxChars: 1_000_000,
    notes: [note("d1", { kind: "work", writtenBy: "dream" })],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "d1", reason: "Work finished" },
  ]);
});

test("no work notes means no call", async () => {
  const { calls, judge } = fakeJudge(() => noFinished());
  await pruneNotes({
    judge,
    maxChars: 1_000_000,
    notes: [note("p1"), note("p2", { kind: "places" })],
    today: TODAY,
  });
  expect(calls).toHaveLength(0);
});

test("budget kept by merging", async () => {
  const { calls, judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? noFinished()
      : mergeAnswer(["n1", "n2"], "merged fact")
  );
  const notes = [
    note("n1", { text: "x".repeat(60) }),
    note("n2", { text: "y".repeat(60) }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 100,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["n2"],
      action: "merge",
      keepNoteId: "n1",
      text: "merged fact",
    },
  ]);
  expect(result.notes).toEqual([
    {
      date: TODAY,
      id: "n1",
      kind: "people",
      source: null,
      text: "merged fact",
      userScope: null,
      writtenBy: "dream",
    },
  ]);
  expect(result.chars).toBe("merged fact".length);
  expect(calls).toHaveLength(1);
});

test("a merge text that is not shorter than its members is refused", async () => {
  const { judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? noFinished()
      : mergeAnswer(["n1", "n2"], "z".repeat(120))
  );
  const notes = [
    note("n1", { text: "x".repeat(60) }),
    note("n2", { text: "y".repeat(60) }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 100,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual(notes);
  expect(result.chars).toBe(120);
});

test("a merge below the confidence floor is refused", async () => {
  const { judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? noFinished()
      : mergeAnswer(["n1", "n2"], "short", 0.6)
  );
  const notes = [
    note("n1", { text: "x".repeat(60) }),
    note("n2", { text: "y".repeat(60) }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 100,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual(notes);
});

test("when the first group is enough, the second group is not judged", async () => {
  const { calls, judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system) ? noFinished() : mergeAnswer(["n1", "n2"], "merged")
  );
  const notes = [
    note("n1", { text: "x".repeat(80) }),
    note("n2", { text: "x".repeat(80) }),
    note("n3", { text: "y".repeat(30), userScope: "user_1" }),
    note("n4", { text: "y".repeat(30), userScope: "user_1" }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 100,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["n2"],
      action: "merge",
      keepNoteId: "n1",
      text: "merged",
    },
  ]);
  expect(result.chars).toBe(6 + 60);
  const budgetCalls = calls.filter((call) => !isFinishedJudge(call.system));
  expect(budgetCalls).toHaveLength(1);
  expect(budgetCalls[0]?.prompt).not.toContain("id=n3");
});

test("when no group fits, the size stays above the budget and nothing is cut", async () => {
  const { calls, judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system) ? noFinished() : JSON.stringify({ groups: [] })
  );
  const notes = [
    note("n1", { text: "x".repeat(40) }),
    note("n2", { text: "x".repeat(40) }),
    note("n3", { text: "y".repeat(40), userScope: "user_1" }),
    note("n4", { text: "y".repeat(40), userScope: "user_1" }),
  ];
  const result = await pruneNotes({ judge, maxChars: 10, notes, today: TODAY });
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual(notes);
  expect(result.chars).toBe(160);
  expect(calls.filter((call) => !isFinishedJudge(call.system))).toHaveLength(2);
});

test("under budget makes no call", async () => {
  const { calls, judge } = fakeJudge(() => noFinished());
  const notes = [
    note("n1", { text: "short" }),
    note("n2", { text: "also short" }),
  ];
  const result = await pruneNotes({
    judge,
    maxChars: 100,
    notes,
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(result.notes).toEqual(notes);
  expect(result.chars).toBe("short".length + "also short".length);
  expect(calls).toHaveLength(0);
});

test("the budget never mixes kinds or scopes in one call or one merge", async () => {
  const { calls, judge } = fakeJudge((prompt, system) => {
    if (isFinishedJudge(system)) {
      return noFinished();
    }
    return mergeAnswer(idsIn(prompt), "merged");
  });
  const notes = [
    note("n1", { text: "x".repeat(50) }),
    note("n2", { text: "x".repeat(50) }),
    note("n3", { text: "y".repeat(50), userScope: "user_1" }),
    note("n4", { text: "y".repeat(50), userScope: "user_1" }),
    note("n5", { kind: "corrections", text: "z".repeat(50) }),
    note("n6", { kind: "corrections", text: "z".repeat(50) }),
  ];
  const result = await pruneNotes({ judge, maxChars: 0, notes, today: TODAY });
  const budgetCalls = calls.filter((call) => !isFinishedJudge(call.system));
  expect(budgetCalls.map((call) => idsIn(call.prompt))).toEqual([
    ["n1", "n2"],
    ["n3", "n4"],
    ["n5", "n6"],
  ]);
  expect(result.changes).toHaveLength(3);
  for (const change of result.changes) {
    if (change.action !== "merge") {
      throw new Error("expected only merges");
    }
    const ids = [change.keepNoteId, ...change.absorbedNoteIds];
    const members = notes.filter((n) => ids.includes(n.id));
    const scopes = new Set(members.map((n) => `${n.kind}/${n.userScope}`));
    expect(scopes.size).toBe(1);
  }
});

test("a dream-written note can be aged out and merged, and the keeper prefers a non-dream note", async () => {
  const { judge } = fakeJudge((prompt, system) => {
    if (isFinishedJudge(system)) {
      return noFinished();
    }
    return mergeAnswer(idsIn(prompt), "merged fact");
  });
  const notes = [
    note("old", { date: ago(61), text: "o".repeat(50), writtenBy: "dream" }),
    note("dream", { text: "d".repeat(50), writtenBy: "dream" }),
    note("agent", { date: ago(5), text: "a".repeat(50) }),
  ];
  const result = await pruneNotes({ judge, maxChars: 60, notes, today: TODAY });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "old", reason: "Not changed for 60 days" },
    {
      absorbedNoteIds: ["dream"],
      action: "merge",
      keepNoteId: "agent",
      text: "merged fact",
    },
  ]);
  expect(result.notes).toEqual([
    { ...note("agent"), date: TODAY, text: "merged fact", writtenBy: "dream" },
  ]);
});

test("a note is never named twice: a stale or finished note is not offered to a merge", async () => {
  const { calls, judge } = fakeJudge((_prompt, system) =>
    isFinishedJudge(system)
      ? JSON.stringify({
          finished: [{ confidence: 0.9, id: "w1", rationale: "done" }],
        })
      : mergeAnswer(["p1", "p2"], "pq")
  );
  const notes = [
    note("w1", { kind: "work", text: "w".repeat(50) }),
    note("s1", { date: ago(90), text: "s".repeat(50) }),
    note("p1", { text: "p".repeat(50) }),
    note("p2", { text: "q".repeat(50) }),
  ];
  const result = await pruneNotes({ judge, maxChars: 60, notes, today: TODAY });
  expect(result.changes).toEqual([
    { action: "drop", noteId: "s1", reason: "Not changed for 60 days" },
    { action: "drop", noteId: "w1", reason: "Work finished" },
    {
      absorbedNoteIds: ["p2"],
      action: "merge",
      keepNoteId: "p1",
      text: "pq",
    },
  ]);
  const budgetCalls = calls.filter((call) => !isFinishedJudge(call.system));
  expect(budgetCalls).toHaveLength(1);
  expect(budgetCalls[0]?.prompt).not.toContain("id=w1");
  expect(budgetCalls[0]?.prompt).not.toContain("id=s1");
});

test("a null, garbage or thrown answer changes nothing in the passes that call the judge", async () => {
  const notes = [
    note("w1", { kind: "work", text: "w".repeat(50) }),
    note("s1", { date: ago(90), text: "s".repeat(50) }),
    note("p1", { text: "p".repeat(50) }),
    note("p2", { text: "q".repeat(50) }),
  ];
  const expected: DreamPlan = [
    { action: "drop", noteId: "s1", reason: "Not changed for 60 days" },
  ];

  const answers: Judge[] = [
    () => Promise.resolve(null),
    () => Promise.resolve("not json at all"),
    () => Promise.reject(new Error("model is down")),
  ];
  const results = await Promise.all(
    answers.map((judge) =>
      pruneNotes({ judge, maxChars: 60, notes, today: TODAY })
    )
  );
  for (const result of results) {
    expect(result.changes).toEqual(expected);
    expect(result.notes.map((n) => n.id)).toEqual(["w1", "p1", "p2"]);
    expect(result.chars).toBe(150);
  }
});
