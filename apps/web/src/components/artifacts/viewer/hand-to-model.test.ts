import { expect, test } from "bun:test";
import { handToAgentId, handToValue, NOBODY_VALUE } from "./hand-to-model.ts";

test("handToValue and handToAgentId round-trip", () => {
  expect(handToValue(null)).toBe(NOBODY_VALUE);
  expect(handToValue("ag1")).toBe("ag1");
  expect(handToAgentId(NOBODY_VALUE)).toBeNull();
  expect(handToAgentId("ag1")).toBe("ag1");
});
