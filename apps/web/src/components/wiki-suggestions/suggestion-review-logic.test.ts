import { expect, test } from "bun:test";
import { lineDiff } from "../library/library-logic.ts";
import { reviewDiff, STALE_NOTE } from "./suggestion-review-logic.ts";

const baseText = "# Title\nold line\n";
const currentText = "# Title\nold line\nnew edit\n";
const proposedText = "# Title\nagent line\n";

test("a pending suggestion diffs the base text to the proposal with no note", () => {
  expect(
    reviewDiff({
      baseText,
      currentText: baseText,
      proposedText,
      status: "pending",
    })
  ).toEqual({ after: proposedText, before: baseText, note: null });
});

test("a stale suggestion diffs the current text to the proposal and carries the note", () => {
  const review = reviewDiff({
    baseText,
    currentText,
    proposedText,
    status: "stale",
  });
  expect(review).toEqual({
    after: proposedText,
    before: currentText,
    note: STALE_NOTE,
  });
});

test("a stale diff lists the newer edit as deleted, which the base diff would not", () => {
  const { before, after } = reviewDiff({
    baseText,
    currentText,
    proposedText,
    status: "stale",
  });
  expect(lineDiff(before, after)).toContainEqual({
    kind: "del",
    text: "new edit",
  });
  expect(lineDiff(baseText, proposedText)).not.toContainEqual({
    kind: "del",
    text: "new edit",
  });
});
