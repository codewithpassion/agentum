import { expect, test } from "bun:test";
import {
  authorOf,
  canAccept,
  canSubmitAnswer,
  canSubmitQuestion,
  previewOf,
  statusLabel,
  statusOfFilter,
  takesAnswers,
} from "./qa-logic.ts";

const names = new Map([["a1", "Triage"]]);

test("the all filter sends no status", () => {
  expect(statusOfFilter("all")).toBeUndefined();
  expect(statusOfFilter("open")).toBe("open");
  expect(statusOfFilter("answered")).toBe("answered");
});

test("an agent author carries its id, run and name", () => {
  expect(
    authorOf({ authorId: "a1", authorKind: "agent", runId: "r1" }, "u1", names)
  ).toEqual({ agentId: "a1", kind: "agent", label: "Triage", runId: "r1" });
  expect(
    authorOf(
      { authorId: "gone", authorKind: "agent", runId: null },
      "u1",
      names
    ).label
  ).toBe("Agent");
});

test("a person author reads You or Teammate and has no links", () => {
  const mine = authorOf(
    { authorId: "u1", authorKind: "user", runId: null },
    "u1",
    names
  );
  expect(mine).toEqual({
    agentId: null,
    kind: "person",
    label: "You",
    runId: null,
  });
  expect(
    authorOf({ authorId: "u2", authorKind: "user", runId: null }, "u1", names)
      .label
  ).toBe("Teammate");
});

test("forms need text and are blocked while sending", () => {
  expect(canSubmitAnswer("  ", false)).toBe(false);
  expect(canSubmitAnswer("yes", true)).toBe(false);
  expect(canSubmitAnswer("yes", false)).toBe(true);
  expect(canSubmitQuestion("t", " ", false)).toBe(false);
  expect(canSubmitQuestion(" ", "b", false)).toBe(false);
  expect(canSubmitQuestion("t", "b", false)).toBe(true);
  expect(canSubmitQuestion("t", "b", true)).toBe(false);
});

test("status words and what each status allows", () => {
  expect(statusLabel("open")).toBe("Open");
  expect(statusLabel("answered")).toBe("Answered");
  expect(statusLabel("closed")).toBe("Closed");
  expect(takesAnswers("open")).toBe(true);
  expect(takesAnswers("answered")).toBe(true);
  expect(takesAnswers("closed")).toBe(false);
});

test("accept is offered until the answer is accepted or the question closed", () => {
  expect(canAccept({ acceptedAnswerId: null, status: "open" }, "x")).toBe(true);
  expect(canAccept({ acceptedAnswerId: "x", status: "answered" }, "x")).toBe(
    false
  );
  expect(canAccept({ acceptedAnswerId: "x", status: "answered" }, "y")).toBe(
    true
  );
  expect(canAccept({ acceptedAnswerId: null, status: "closed" }, "x")).toBe(
    false
  );
});

test("a preview is the first line, cut at the limit", () => {
  expect(previewOf("first\nsecond")).toBe("first");
  expect(previewOf("abcdef", 4)).toBe("abc…");
  expect(previewOf("")).toBe("");
});
