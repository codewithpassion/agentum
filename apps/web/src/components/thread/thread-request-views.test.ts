import { expect, test } from "bun:test";
import type { TaskLive } from "../task/task-state.ts";
import { threadRequestViews } from "./thread-request-views.ts";

test("earlier request cards retain their settlement after navigating to a new run", () => {
  const base = {
    actor: { id: "u", kind: "user" as const },
    agentId: "a",
    createdAt: "2026-11-05T22:03:00Z",
    payloadRef: null,
    runId: "old",
    seq: null,
    sessionId: "s",
    workspaceId: "w",
  };
  const events: TaskLive["events"] = [
    {
      ...base,
      id: "1",
      payload: {
        display: { questions: [{ question: "Which?" }] },
        expiresAt: "2030-01-01T00:00:00Z",
        kind: "question",
        requestId: "req",
      },
      type: "request.opened",
    },
    {
      ...base,
      id: "2",
      payload: { requestId: "req" },
      type: "request.cancelled",
    },
  ];
  const requests = threadRequestViews(events, new Map());
  expect(requests.get("req")?.runId).toBe("old");
  expect(requests.get("req")?.settled).toEqual({ status: "cancelled" });
});
