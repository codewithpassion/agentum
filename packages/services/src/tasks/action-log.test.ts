import { expect, test } from "bun:test";
import { toActionLog } from "./action-log.ts";
import { event } from "./fixtures.test-helper.ts";

test.each([
  ["message.reasoning", "thought"],
  ["tool.call", "tool_call"],
  ["tool.result", "tool_result"],
  ["request.opened", "note"],
  ["request.answered", "note"],
  ["request.expired", "note"],
  ["request.cancelled", "note"],
  ["run.limit_reached", "note"],
  ["run.failed", "error"],
  ["connector.needs_auth", "error"],
  ["connector.timeout", "error"],
] as const)("maps %s to %s", (type, kind) => {
  expect(
    toActionLog([event(type, { text: "Text [ATTACHMENT:/file]" })])
  ).toMatchObject([
    { at: "2026-10-26T00:00:00Z", eventId: type, kind, text: "Text" },
  ]);
});
test("failed results and connector calls are errors only on failure", () => {
  expect(
    toActionLog([
      event("tool.result", { ok: false, output: "Failed" }),
      event("connector.call", { error: "Failed", ok: false }),
    ]).map((entry) => entry.kind)
  ).toEqual(["error", "error"]);
  expect(
    toActionLog([event("connector.call", { ok: true }), event("run.queued")])
  ).toEqual([]);
});
test("external payloads have readable fallbacks", () => {
  expect(
    toActionLog([{ ...event("tool.call"), payloadRef: "payloads/a" }])[0]?.text
  ).toBe("Tool call");
});

test.each(["timeout", "unreachable", "refused", "blocked", "retry"])(
  "proxy connector outcome %s is an error",
  (outcome) => {
    const entries = toActionLog([
      event("connector.call", { outcome, tool: "search" }),
    ]);
    expect(entries[0]?.kind).toBe("error");
    expect(entries[0]?.text).toContain(outcome);
  }
);

test("connector HTTP failures are errors, while ok and redirects are omitted", () => {
  expect(
    toActionLog([
      event("connector.call", { httpStatus: 503, outcome: "ok" }),
    ])[0]?.kind
  ).toBe("error");
  expect(
    toActionLog([
      event("connector.call", { outcome: "ok" }),
      event("connector.call", { outcome: "redirect" }),
    ])
  ).toEqual([]);
});
