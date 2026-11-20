import { expect, test } from "bun:test";
import { startTaskBody } from "./new-task-logic.ts";

const base = { agentId: "agt_1", requestId: "req_1", text: "  hello  " };

test("a private conversation sends session.private true", () => {
  const body = startTaskBody({ ...base, isPrivate: true });
  expect(body.session).toEqual({ origin: "ui", private: true });
});

test("a shared conversation sends session.private false", () => {
  const body = startTaskBody({ ...base, isPrivate: false });
  expect(body.session).toEqual({ origin: "ui", private: false });
});

test("the text is trimmed and no files are sent", () => {
  const body = startTaskBody({ ...base, isPrivate: false });
  expect(body.input).toEqual({ fileIds: [], text: "hello" });
});

test("the agent and request id pass through unchanged", () => {
  const body = startTaskBody({ ...base, isPrivate: false });
  expect(body.agentId).toBe("agt_1");
  expect(body.requestId).toBe("req_1");
});
