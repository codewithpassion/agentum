// Ports the Brain's canary cases (g), a low-confidence merge is not made, and
// (h), a cluster is one kind and one scope, and the degrade path of judge.ts (a
// null or unparseable answer changes nothing and never throws). The other
// cases are written here for notes.
import { expect, test } from "bun:test";
import { MEMORY_NOTE_MAX_CHARS, type MemoryNote } from "@repo/db/shared";
import type { Judge } from "./judge.ts";
import { mergeNotes, type NoteCandidate } from "./merge.ts";

const TODAY = "2026-11-20";

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

const candidate = (
  text: string,
  overrides: Partial<NoteCandidate> = {}
): NoteCandidate => ({
  action: "add",
  kind: "people",
  source: null,
  text,
  userScope: null,
  ...overrides,
});

interface Call {
  prompt: string;
  system: string;
}

/** A judge that answers each call with `reply(prompt)` and records what it was asked. */
const fakeJudge = (reply: (prompt: string) => string | null) => {
  const calls: Call[] = [];
  const judge: Judge = (prompt, system) => {
    calls.push({ prompt, system });
    return Promise.resolve(reply(prompt));
  };
  return { calls, judge };
};

/** A judge answer with one group. */
const oneGroup = (ids: string[], text: string, confidence = 0.9): string =>
  JSON.stringify({
    groups: [{ confidence, ids, rationale: "same point", text }],
  });

test("exact duplicate: a candidate equal to an existing note gives no change and no judge call", async () => {
  const { calls, judge } = fakeJudge(() => null);
  const result = await mergeNotes({
    candidates: [candidate("  DOM prefers   short emails ")],
    judge,
    notes: [note("n1", { text: "Dom prefers short emails." })],
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("exact duplicate: two identical existing notes merge into the person note, with no judge call", async () => {
  const { calls, judge } = fakeJudge(() => null);
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("d1", {
        date: "2026-01-01",
        text: "Dom likes tea.",
        writtenBy: "dream",
      }),
      note("p1", {
        date: "2026-11-05",
        text: "Dom likes tea.",
        writtenBy: "person",
      }),
    ],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["d1"],
      action: "merge",
      keepNoteId: "p1",
      text: "Dom likes tea.",
    },
  ]);
  expect(calls).toHaveLength(0);
});

test("near duplicate: an existing note and a candidate the judge groups become one merge", async () => {
  const { calls, judge } = fakeJudge(() =>
    oneGroup(["n1", "new-1"], "Dom prefers brief emails, no filler.")
  );
  const result = await mergeNotes({
    candidates: [candidate("Dom likes brief emails.")],
    judge,
    notes: [note("n1", { text: "Dom prefers short emails." })],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: [],
      action: "merge",
      keepNoteId: "n1",
      text: "Dom prefers brief emails, no filler.",
    },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain(
    "- id=new-1 (by new): Dom likes brief emails."
  );
});

test("near duplicate: two existing notes fold into the oldest fresh note, and a dream note is absorbed", async () => {
  const { judge } = fakeJudge(() =>
    oneGroup(["n1", "n2", "n3"], "Dom likes short emails, no filler.")
  );
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("n1", { date: "2026-11-02", text: "Dom likes short mail." }),
      note("n2", { date: "2026-10-01", text: "Dom likes short emails." }),
      note("n3", {
        date: "2026-01-01",
        text: "Dom likes short emails a lot.",
        writtenBy: "dream",
      }),
    ],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["n1", "n3"],
      action: "merge",
      keepNoteId: "n2",
      text: "Dom likes short emails, no filler.",
    },
  ]);
});

test("near duplicate: two candidates the judge groups become one add", async () => {
  const { calls, judge } = fakeJudge(() =>
    oneGroup(["new-1", "new-2"], "Dom likes short emails, no filler.")
  );
  const result = await mergeNotes({
    candidates: [
      candidate("Dom likes short emails."),
      candidate("Dom likes brief emails."),
    ],
    judge,
    notes: [],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      action: "add",
      kind: "people",
      source: null,
      text: "Dom likes short emails, no filler.",
      userScope: null,
    },
  ]);
  expect(calls).toHaveLength(1);
});

test("a judged group whose text is already the keeper's text makes no change, and its candidate is not added", async () => {
  const { calls, judge } = fakeJudge(() =>
    oneGroup(["n1", "new-1"], "Dom prefers short emails")
  );
  const result = await mergeNotes({
    candidates: [candidate("Dom likes brief emails.")],
    judge,
    notes: [note("n1", { text: "Dom prefers short emails." })],
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("a low-confidence merge is not made: the candidate is added as it is", async () => {
  const existing = note("n1", { text: "Dom prefers short emails." });
  const { judge } = fakeJudge(() =>
    oneGroup(["n1", "new-1"], "Dom prefers brief emails.", 0.5)
  );
  const result = await mergeNotes({
    candidates: [candidate("Dom likes brief emails.")],
    judge,
    notes: [existing],
    today: TODAY,
  });
  expect(result.changes).toEqual([candidate("Dom likes brief emails.")]);
  expect(result.notes).toEqual([existing]);
});

test("never mixes kinds or scopes: one judge call per group, and no prompt holds another group's note", async () => {
  const { calls, judge } = fakeJudge((prompt) =>
    prompt.includes("id=n1")
      ? oneGroup(["n1", "new-1"], "Dom prefers brief emails.")
      : oneGroup(["n2", "new-2"], "Dom prefers brief emails at work.")
  );
  const result = await mergeNotes({
    candidates: [
      candidate("Dom likes brief emails."),
      candidate("Dom likes brief emails.", { kind: "work" }),
    ],
    judge,
    notes: [
      note("n1", { text: "Dom prefers short emails." }),
      note("n2", { kind: "work", text: "Dom prefers short emails at work." }),
      note("n3", { text: "Dom prefers short emails.", userScope: "user_1" }),
    ],
    today: TODAY,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).toContain("id=n1");
  expect(calls[0]?.prompt).not.toContain("id=n2");
  expect(calls[0]?.prompt).not.toContain("id=n3");
  expect(calls[1]?.prompt).toContain("id=n2");
  expect(calls[1]?.prompt).not.toContain("id=n1");
  expect(calls[1]?.prompt).not.toContain("id=n3");
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: [],
      action: "merge",
      keepNoteId: "n1",
      text: "Dom prefers brief emails.",
    },
    {
      absorbedNoteIds: [],
      action: "merge",
      keepNoteId: "n2",
      text: "Dom prefers brief emails at work.",
    },
  ]);
});

test("a null, garbage or thrown judge answer adds the candidates and counts the group as skipped", async () => {
  const replies: ((prompt: string) => string | null)[] = [
    () => null,
    () => "not json",
    () => {
      throw new Error("judge down");
    },
  ];
  await Promise.all(
    replies.map(async (reply) => {
      const { calls, judge } = fakeJudge(reply);
      const result = await mergeNotes({
        candidates: [candidate("Dom likes brief emails.")],
        judge,
        notes: [note("n1", { text: "Dom prefers short emails." })],
        today: TODAY,
      });
      expect(result.changes).toEqual([candidate("Dom likes brief emails.")]);
      expect(result.skippedGroups).toBe(1);
      expect(calls).toHaveLength(1);
    })
  );
});

test("the judge cannot invent ids or overlong text: such a group makes no change", async () => {
  const answers = [
    oneGroup(["n1", "new-1", "ghost"], "Dom prefers brief emails."),
    oneGroup(["n1", "new-1"], "x".repeat(MEMORY_NOTE_MAX_CHARS + 1)),
  ];
  await Promise.all(
    answers.map(async (answer) => {
      const { judge } = fakeJudge(() => answer);
      const result = await mergeNotes({
        candidates: [candidate("Dom likes brief emails.")],
        judge,
        notes: [note("n1", { text: "Dom prefers short emails." })],
        today: TODAY,
      });
      expect(result.changes).toEqual([candidate("Dom likes brief emails.")]);
    })
  );
});

test("dream notes are not fresh evidence: similar dream notes make no judge call and no change", async () => {
  const { calls, judge } = fakeJudge(() =>
    oneGroup(["n1", "n2"], "Dom likes tea.")
  );
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("n1", { text: "Dom likes tea", writtenBy: "dream" }),
      note("n2", { text: "Dom likes tea a lot", writtenBy: "dream" }),
    ],
    today: TODAY,
  });
  expect(result.changes).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("the notes after the merge drop the absorbed note and rewrite the keeper as a dream note dated today", async () => {
  const { judge } = fakeJudge(() =>
    oneGroup(["n1", "n2"], "Dom prefers brief emails.")
  );
  const other = note("n3", { kind: "work", text: "Ship on Friday." });
  const result = await mergeNotes({
    candidates: [],
    judge,
    notes: [
      note("n1", {
        date: "2026-11-02",
        text: "Dom likes short emails.",
        writtenBy: "dream",
      }),
      note("n2", {
        date: "2026-11-03",
        text: "Dom prefers short emails.",
        writtenBy: "person",
      }),
      other,
    ],
    today: TODAY,
  });
  expect(result.changes).toEqual([
    {
      absorbedNoteIds: ["n1"],
      action: "merge",
      keepNoteId: "n2",
      text: "Dom prefers brief emails.",
    },
  ]);
  expect(result.notes).toEqual([
    {
      ...note("n2", { text: "Dom prefers short emails." }),
      date: TODAY,
      text: "Dom prefers brief emails.",
      writtenBy: "dream",
    },
    other,
  ]);
});
