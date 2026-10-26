import { expect, test } from "bun:test";
import { createMasker } from "@repo/protocol/masker";
import { type RequestRow, requestRecord, scrubAnswer } from "./records.ts";

const takeoverRow: RequestRow = {
  agentId: "a1",
  answer: null,
  answeredAt: null,
  answeredBy: null,
  answeredVia: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  deliveredAt: null,
  display: JSON.stringify({ machineId: "m1", reason: "log in" }),
  expiresAt: "2026-01-02T00:00:00.000Z",
  id: "r1",
  kind: "takeover",
  questionKeys: null,
  runId: "run1",
  sessionId: "s1",
  slackMessage: null,
  status: "pending",
  toolKey: null,
  toolName: "request_human_takeover",
  toolUseId: "call1",
  workspaceId: "w1",
};

test("a takeover row parses its display and answer", () => {
  expect(requestRecord(takeoverRow).display).toEqual({
    machineId: "m1",
    reason: "log in",
  });
  expect(
    requestRecord({
      ...takeoverRow,
      answer: JSON.stringify({ note: "done" }),
      status: "answered",
    }).answer
  ).toEqual({ note: "done" });
  expect(() =>
    requestRecord({
      ...takeoverRow,
      answer: JSON.stringify({ decision: "deny" }),
    })
  ).toThrow();
});

test("a takeover answer keeps its note, scrubbed, and an empty one stays empty", () => {
  const masker = createMasker({ PASSWORD: "hunter2" });
  expect(
    scrubAnswer({ note: "password is hunter2" }, masker).note
  ).not.toContain("hunter2");
  expect(scrubAnswer({}, masker)).toEqual({});
});
