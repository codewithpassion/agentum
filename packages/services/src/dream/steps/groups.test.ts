// Ported from the-brain/packages/db/src/dream/select.ts: a cluster is one kind
// and one tier (dream.canary.test.ts case (h), entity-dedup.test.ts "different
// kind" and "different scope partition"). Here the tier is the note's
// `userScope`. The other helpers are new, written for notes.
import { expect, test } from "bun:test";
import type { MemoryNote } from "@repo/db/shared";
import {
  mergeChange,
  notesAfterMerge,
  parseMergeGroups,
  pickKeeper,
  scopeGroups,
} from "./groups.ts";

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

test("scopeGroups never mixes a kind or a userScope", () => {
  const groups = scopeGroups([
    note("a"),
    note("b", { kind: "work" }),
    note("c", { userScope: "user_1" }),
    note("d", { userScope: "user_2" }),
    note("e"),
  ]);
  expect(groups.map((group) => group.map((n) => n.id))).toEqual([
    ["a", "e"],
    ["b"],
    ["c"],
    ["d"],
  ]);
});

test("pickKeeper prefers a person or agent note, then the oldest, then the smaller id", () => {
  const dream = note("a", { date: "2026-01-01", writtenBy: "dream" });
  const newer = note("b", { date: "2026-11-01" });
  const older = note("c", { date: "2026-10-01" });
  expect(pickKeeper([dream, newer, older])?.id).toBe("c");
  expect(pickKeeper([note("z"), note("y")])?.id).toBe("y");
  expect(pickKeeper([])).toBeNull();
});

test("parseMergeGroups clamps ids to the ones shown, drops overlaps and bad text", () => {
  const valid = new Set(["a", "b", "c", "d"]);
  const groups = parseMergeGroups(
    {
      groups: [
        { confidence: 0.9, ids: ["a", "b", "ghost"], text: " One  line " },
        { confidence: 0.9, ids: ["b", "c"], text: "overlaps b" },
        { confidence: 0.9, ids: ["c"], text: "only one id" },
        { confidence: 0.9, ids: ["c", "d"], text: "" },
        { confidence: "high", ids: ["c", "d"], text: "fine" },
      ],
    },
    valid
  );
  expect(groups).toEqual([
    { confidence: 0.9, ids: ["a", "b"], text: "One line" },
    { confidence: 0, ids: ["c", "d"], text: "fine" },
  ]);
  expect(parseMergeGroups({}, valid)).toEqual([]);
});

test("notesAfterMerge drops the absorbed notes and rewrites the keeper as dream-written today", () => {
  const keeper = note("a", { writtenBy: "person" });
  const absorbed = note("b");
  const other = note("c");
  const change = mergeChange(keeper, [absorbed], "merged");
  expect(change).toEqual({
    absorbedNoteIds: ["b"],
    action: "merge",
    keepNoteId: "a",
    text: "merged",
  });
  const after = notesAfterMerge(
    [keeper, absorbed, other],
    change,
    "2026-11-20"
  );
  expect(after).toEqual([
    { ...keeper, date: "2026-11-20", text: "merged", writtenBy: "dream" },
    other,
  ]);
});

test("pickKeeper puts a person's note before an agent's, even when the agent's is older", () => {
  const person = note("p", { date: "2026-11-01", writtenBy: "person" });
  const agent = note("a", { date: "2026-01-01" });
  expect(pickKeeper([agent, person])?.id).toBe("p");
});

test("notesAfterMerge leaves a keeper whose text does not change as it was", () => {
  const keeper = note("a", { writtenBy: "person" });
  const change = mergeChange(keeper, [note("b")], keeper.text);
  expect(notesAfterMerge([keeper, note("b")], change, "2026-11-20")).toEqual([
    keeper,
  ]);
});

test("mergeChange keeps the keeper's own text when the new text differs only in case, spacing or a full stop", () => {
  const keeper = note("a", { text: "Mia wants docs", writtenBy: "person" });
  expect(mergeChange(keeper, [note("b")], "mia  wants DOCS.").text).toBe(
    "Mia wants docs"
  );
  expect(mergeChange(keeper, [note("b")], "Mia wants PDFs").text).toBe(
    "Mia wants PDFs"
  );
});
