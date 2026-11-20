import { expect, test } from "bun:test";
import type { DreamCounts, DreamPlan } from "@repo/db/shared";
import { writeDiary } from "./diary.ts";

const NONE: DreamCounts = { added: 0, dropped: 0, merged: 0, questions: 0 };
const NOTES: Record<string, string> = {
  "note-a": "Dominik prefers short reports",
  "note-b": "The Harbour Edge deck uses navy.",
};
const publicText = (noteId: string): string | null => NOTES[noteId] ?? null;
const noPrivate = (): string | null => null;

const addPublic = (text: string) => ({
  action: "add" as const,
  kind: "work" as const,
  source: null,
  text,
  userScope: null,
});

test("all zero counts say nothing needed changing, even with an empty plan", () => {
  expect(
    writeDiary({ counts: NONE, held: false, noteText: publicText, plan: [] })
  ).toBe("Nothing needed changing.");
  expect(
    writeDiary({ counts: NONE, held: true, noteText: publicText, plan: [] })
  ).toBe("Nothing needed changing.");
});

test("counts become one sentence with only the nonzero parts", () => {
  expect(
    writeDiary({
      counts: { added: 2, dropped: 3, merged: 1, questions: 0 },
      held: false,
      noteText: publicText,
      plan: [],
    })
  ).toBe("Added 2 notes, merged 1 and dropped 3.");
  expect(
    writeDiary({
      counts: { added: 1, dropped: 2, merged: 0, questions: 1 },
      held: false,
      noteText: publicText,
      plan: [],
    })
  ).toBe("Added 1 note and dropped 2. 1 question is waiting for you.");
  expect(
    writeDiary({
      counts: { added: 0, dropped: 0, merged: 0, questions: 2 },
      held: false,
      noteText: publicText,
      plan: [],
    })
  ).toBe("2 questions are waiting for you.");
});

test("held batches start with the approval line and use the would wording", () => {
  const plan: DreamPlan = [
    addPublic("Ships on Fridays."),
    { action: "drop", noteId: "note-a", reason: "Repeats a newer note." },
  ];
  expect(
    writeDiary({
      counts: { added: 2, dropped: 3, merged: 1, questions: 0 },
      held: true,
      noteText: publicText,
      plan,
    })
  ).toBe(
    [
      "These changes wait for your approval. Wants to add 2 notes, merge 1 and drop 3.",
      "Would add: Ships on Fridays.",
      "Would drop: Dominik prefers short reports. Repeats a newer note.",
    ].join("\n")
  );
});

test("plan lines use the past wording and keep Asked in held batches", () => {
  const plan: DreamPlan = [
    {
      absorbedNoteIds: ["note-b"],
      action: "merge",
      keepNoteId: "note-a",
      text: "Dominik prefers short reports and navy decks.",
    },
    { action: "question", noteIds: ["note-a"], question: "Which is current?" },
  ];
  expect(
    writeDiary({
      counts: { added: 0, dropped: 0, merged: 1, questions: 1 },
      held: false,
      noteText: publicText,
      plan,
    })
  ).toBe(
    [
      "Merged 1. 1 question is waiting for you.",
      "Merged into one: Dominik prefers short reports and navy decks.",
      "Asked: Which is current?",
    ].join("\n")
  );
  const [, , askedLine] = writeDiary({
    counts: { added: 0, dropped: 0, merged: 1, questions: 1 },
    held: true,
    noteText: publicText,
    plan,
  }).split("\n");
  expect(askedLine).toBe("Asked: Which is current?");
});

test("the plan prints at most twelve lines, then a count of the rest", () => {
  const plan: DreamPlan = Array.from({ length: 13 }, (_, index) =>
    addPublic(`Fact ${index + 1}.`)
  );
  const lines = writeDiary({
    counts: { added: 13, dropped: 0, merged: 0, questions: 0 },
    held: false,
    noteText: publicText,
    plan,
  }).split("\n");
  expect(lines).toHaveLength(14);
  expect(lines[1]).toBe("Added: Fact 1.");
  expect(lines[12]).toBe("Added: Fact 12.");
  expect(lines[13]).toBe("...and 1 more.");
});

test("a private add never prints its text", () => {
  const plan: DreamPlan = [
    {
      action: "add",
      kind: "work",
      source: null,
      text: "Secret salary figure.",
      userScope: "user-1",
    },
  ];
  const counts = { added: 1, dropped: 0, merged: 0, questions: 0 };
  const output = writeDiary({
    counts,
    held: false,
    noteText: noPrivate,
    plan,
  });
  expect(output).toBe("Added 1 note.\nAdded a private note.");
  expect(output).not.toContain("Secret");
  expect(
    writeDiary({ counts, held: true, noteText: noPrivate, plan })
  ).toContain("Would add a private note.");
});

test("a merge that touches a private note never prints its text", () => {
  const counts = { added: 0, dropped: 0, merged: 1, questions: 0 };
  const merge = (keepNoteId: string, absorbedNoteIds: string[]): DreamPlan => [
    { absorbedNoteIds, action: "merge", keepNoteId, text: "Merged secret." },
  ];
  const lookup = (noteId: string): string | null =>
    noteId === "note-a" ? "Public note." : null;

  const privateKeep = writeDiary({
    counts,
    held: false,
    noteText: lookup,
    plan: merge("private-1", ["note-a"]),
  });
  expect(privateKeep).toBe("Merged 1.\nMerged private notes.");

  const privateAbsorbed = writeDiary({
    counts,
    held: true,
    noteText: lookup,
    plan: merge("note-a", ["private-1"]),
  });
  expect(privateAbsorbed).toContain("Would merge private notes.");
  expect(privateAbsorbed).not.toContain("Merged secret");
});

test("a drop of a private note never prints its text or reason", () => {
  const plan: DreamPlan = [
    { action: "drop", noteId: "private-1", reason: "Duplicates secret." },
  ];
  const output = writeDiary({
    counts: { added: 0, dropped: 1, merged: 0, questions: 0 },
    held: false,
    noteText: noPrivate,
    plan,
  });
  expect(output).toBe("Dropped 1.\nDropped a private note.");
  expect(output).not.toContain("secret");
});

test("a question about a private note never prints its text", () => {
  const plan: DreamPlan = [
    {
      action: "question",
      noteIds: ["note-a", "private-1"],
      question: "Does the secret pay rise apply?",
    },
  ];
  const output = writeDiary({
    counts: { added: 0, dropped: 0, merged: 0, questions: 1 },
    held: false,
    noteText: (noteId) => (noteId === "note-a" ? "Public note." : null),
    plan,
  });
  expect(output).toBe(
    "1 question is waiting for you.\nAsked a question about a private note."
  );
  expect(output).not.toContain("secret");
});

test("long text is clipped to 140 characters and ends with an ellipsis", () => {
  const longText = "x".repeat(200);
  const plan: DreamPlan = [addPublic(longText)];
  const lines = writeDiary({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    held: false,
    noteText: publicText,
    plan,
  }).split("\n");
  expect(lines[1]).toBe(`Added: ${"x".repeat(140)}...`);
});

test("clipping keeps whole characters when text has emoji", () => {
  const emojiText = "🙂".repeat(141);
  const plan: DreamPlan = [addPublic(emojiText)];
  const [, line] = writeDiary({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    held: false,
    noteText: publicText,
    plan,
  }).split("\n");
  expect(line).toBe(`Added: ${"🙂".repeat(140)}...`);
});
