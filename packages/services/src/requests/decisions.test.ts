import { expect, test } from "bun:test";
import { decisionsWakeText, isDecisionsRequest } from "./decisions.ts";
import { outcomeOf, type RequestRow } from "./records.ts";

const row: RequestRow = {
  agentId: "a1",
  answer: JSON.stringify({ decisions: { q1: "Red", q2: "a\nb  c" } }),
  answeredAt: null,
  answeredBy: null,
  answeredVia: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  deliveredAt: null,
  display: JSON.stringify({
    questions: [
      { id: "q1", options: ["Red", "Blue"], text: "Which\ncolour?" },
      { freeText: true, id: "q2", options: ["x", "y"], text: "Notes?" },
      { id: "q3", options: ["Now", "Later"], text: "When?" },
    ],
  }),
  expiresAt: "2026-01-02T00:00:00.000Z",
  id: "r1",
  kind: "decisions",
  questionKeys: null,
  runId: "run1",
  sessionId: "s1",
  slackMessage: null,
  status: "answered",
  toolKey: null,
  toolName: "ask_decisions",
  toolUseId: "decisions:01",
  workspaceId: "w1",
};

test("the wake text has one line per question, in order, and says which have no answer", () => {
  const lines = decisionsWakeText(row).split("\n");
  expect(lines.slice(1)).toEqual([
    "Which colour?: Red",
    "Notes?: a b c",
    "When?: no answer",
  ]);
});

test("an expired queue says so in its first line", () => {
  expect(decisionsWakeText({ ...row, status: "expired" })).toContain(
    "have expired"
  );
});

test("each line is masked", () => {
  expect(
    decisionsWakeText(row, (line) => line.replaceAll("Red", "***"))
  ).not.toContain("Red");
});

test("only a decisions row with the prefix is a decision queue", () => {
  expect(isDecisionsRequest(row)).toBe(true);
  expect(
    isDecisionsRequest({ toolName: "ask_decisions", toolUseId: "call1" })
  ).toBe(false);
  expect(
    isDecisionsRequest({ toolName: "other", toolUseId: "decisions:01" })
  ).toBe(false);
});

test("an expired or cancelled row keeps its partial answers out of its outcome", () => {
  expect(outcomeOf({ ...row, status: "expired" })).toEqual({
    status: "expired",
  });
  expect(outcomeOf({ ...row, status: "cancelled" })).toEqual({
    status: "cancelled",
  });
  expect(outcomeOf({ ...row, status: "pending" })).toBeNull();
  expect(outcomeOf(row)).toMatchObject({ status: "answered" });
});
