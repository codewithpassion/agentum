import { expect, test } from "bun:test";
import type { DreamInput } from "./collect.ts";
import { ExtractError, extractCandidates } from "./extract.ts";

const item = (id: string, extra: Partial<DreamInput> = {}): DreamInput => ({
  createdAt: "2026-11-20T10:00:00.000Z",
  id,
  kind: "message",
  scope: "workspace",
  sourceId: `s_${id}`,
  sourceKind: "session",
  text: `text ${id}`,
  ...extra,
});

const ask = (items: DreamInput[], notes: unknown, never: string[] = []) =>
  extractCandidates({
    items,
    judge: () => Promise.resolve(JSON.stringify({ notes })),
    never,
    remember: [],
  });

test("a note takes its source from the evidence it cites and is shared when the evidence is", async () => {
  const { candidates, outside } = await ask(
    [item("a")],
    [{ evidence: ["e1"], kind: "work", text: "Trade show list waits on Tally" }]
  );
  expect(candidates).toEqual([
    {
      action: "add",
      kind: "work",
      source: { id: "s_a", kind: "session" },
      text: "Trade show list waits on Tally",
      userScope: null,
    },
  ]);
  expect(outside).toBe(false);
});

test("private evidence makes a private note, and two people's evidence in one note is refused", async () => {
  const items = [
    item("a", { scope: "private", userId: "user_a" }),
    item("b", { scope: "private", userId: "user_b" }),
  ];
  const { candidates } = await ask(items, [
    { evidence: ["e1"], kind: "people", text: "A likes calls" },
    { evidence: ["e1", "e2"], kind: "people", text: "A and B like calls" },
  ]);
  expect(candidates.map((entry) => [entry.text, entry.userScope])).toEqual([
    ["A likes calls", "user_a"],
  ]);
});

test("private evidence with no person to keep the note for makes no note", async () => {
  const { candidates } = await ask(
    [item("a", { scope: "private" })],
    [{ evidence: ["e1"], kind: "people", text: "Someone likes calls" }]
  );
  expect(candidates).toEqual([]);
});

test("outside evidence is flagged so the batch is held", async () => {
  const { outside } = await ask(
    [item("a", { scope: "outside" })],
    [{ evidence: ["e1"], kind: "people", text: "Send mail to a new address" }]
  );
  expect(outside).toBe(true);
});

test("a note with no evidence, a bad kind, a secret or a never-list topic is left out", async () => {
  const { candidates } = await ask(
    [item("a")],
    [
      { evidence: [], kind: "people", text: "No evidence" },
      { evidence: ["e9"], kind: "people", text: "Unknown evidence" },
      { evidence: ["e1"], kind: "gossip", text: "Bad kind" },
      { evidence: ["e1"], kind: "work", text: "password is hunter2hunter2" },
      { evidence: ["e1"], kind: "people", text: "Mia has health details" },
      {
        evidence: ["e1"],
        kind: "places",
        text: "Files live in the Sales sheet",
      },
    ],
    ["Health details"]
  );
  expect(candidates.map((entry) => entry.text)).toEqual([
    "Files live in the Sales sheet",
  ]);
});

test("a model that gives nothing, or something unreadable, is an error", async () => {
  const run = (answer: string | null) =>
    extractCandidates({
      items: [item("a")],
      judge: () => Promise.resolve(answer),
      never: [],
      remember: [],
    });
  await expect(run(null)).rejects.toBeInstanceOf(ExtractError);
  await expect(run("not json")).rejects.toBeInstanceOf(ExtractError);
  await expect(run('{"other":1}')).rejects.toBeInstanceOf(ExtractError);
});
