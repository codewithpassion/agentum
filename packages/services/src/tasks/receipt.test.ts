import { expect, test } from "bun:test";
import { call, event, result, run } from "./fixtures.test-helper.ts";
import { buildReceipt } from "./receipt.ts";

test("empty run has one UI origin step; Slack and handoffs have their own origins", () => {
  expect(buildReceipt(run(), [])).toMatchObject([{ index: 1, kind: "trigger", title: "From UI", countToNext: null }]);
  expect(buildReceipt(run(), [event("run.queued", { origin: "slack", depth: 0 })])[0]?.title).toBe("From Slack");
  expect(buildReceipt(run({ parentRunId: "parent", parentAgentName: "Ada" }), [])[0]?.title).toBe("Handoff from Ada");
});

test("three consecutive tool calls fold, including interleaved results, with a count", () => {
  const steps = buildReceipt(run(), [call("a"), result("a", "plain"), call("b"), result("b", "plain"), call("c"), result("c", "plain"), event("message.assistant", { text: "Finished [ATTACHMENT:/file]" })]);
  expect(steps).toHaveLength(3);
  expect(steps[1]).toMatchObject({ title: "Web search ×3", state: "done", countToNext: { n: 3, noun: "calls" }, eventIds: ["call-a", "result-a", "call-b", "result-b", "call-c", "result-c"] });
  expect(steps[2]?.detail).toBe("Finished");
});

test("assistant messages and different tools break folding; late results match their call", () => {
  const steps = buildReceipt(run(), [call("a"), call("b", "read"), result("a", "{}"), event("message.assistant", { text: "Next" }), call("c"), result("b", "bad", false)]);
  expect(steps.filter((step) => step.kind === "tool")).toHaveLength(3);
  expect(steps[2]?.state).toBe("failed");
  expect(steps[1]?.state).toBe("done");
});

test("chips are scalar, capped and truncated; JSON array lengths supply counts", () => {
  const steps = buildReceipt(run(), [call("a", "search", { a: "x".repeat(120), b: 2, c: false, d: null, nested: {} }), result("a", JSON.stringify({ items: [1, 2], a: "one", b: 2, c: true, d: 4 })), event("message.assistant", { text: "Done" })]);
  expect(steps[1]?.in).toHaveLength(3);
  expect(steps[1]?.in[0]?.value.length).toBeLessThanOrEqual(80);
  expect(steps[1]?.out).toHaveLength(3);
  expect(steps[1]?.countToNext).toEqual({ n: 2, noun: "items" });
  expect(buildReceipt(run(), [call("a"), result("a", "[1,2,3]")])[1]?.out).toEqual([]);
});

test("approval and question steps carry request ids and settle on closure", () => {
  for (const kind of ["approval", "question"]) {
    const opened = event("request.opened", { requestId: "request", kind, toolName: "write", display: { summary: "Write file", questions: [{ question: "Which file?" }] } });
    expect(buildReceipt(run({ status: "waiting" }), [opened])[1]).toMatchObject({ kind, state: "paused", requestId: "request" });
    expect(buildReceipt(run(), [opened, event("request.answered", { requestId: "request" })])[1]?.state).toBe("done");
  }
});

test("skills are individual steps using runtime-specific keys", () => {
  const steps = buildReceipt(run(), [call("a", "activate_skill", { name: "research" }), call("b", "Skill", { skill: "review" })]);
  expect(steps.slice(1).map((step) => step.title)).toEqual(["Skill: research", "Skill: review"]);
});

test("external payloads and malformed JSON render safely without chips", () => {
  const external = { ...call("a"), payload: {}, payloadRef: "payloads/a" };
  const steps = buildReceipt(run(), [external, result("a", "{broken"), event("message.assistant", { text: "done" })]);
  expect(steps[1]).toMatchObject({ in: [], out: [] });
});
