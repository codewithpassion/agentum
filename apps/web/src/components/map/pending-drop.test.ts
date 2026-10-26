import { expect, test } from "bun:test";
import {
  type PendingAgentDrop,
  parseAgentDrop,
  resolveAgentDrop,
} from "./pending-drop.ts";

const HOUR_MS = 60 * 60 * 1000;
const drop: PendingAgentDrop = { at: 1000, known: ["agent:a"], x: 5, y: 9 };

test("waits while no new agent is on the map", () => {
  expect(resolveAgentDrop(drop, ["agent:a", "trigger:t"], 2000)).toEqual({
    kind: "wait",
  });
});

test("places the first agent that was not known", () => {
  expect(
    resolveAgentDrop(drop, ["agent:a", "trigger:t2", "agent:b"], 2000)
  ).toEqual({ key: "agent:b", kind: "place", x: 5, y: 9 });
});

test("gives up after an hour", () => {
  expect(resolveAgentDrop(drop, ["agent:b"], 1000 + HOUR_MS + 1)).toEqual({
    kind: "expired",
  });
});

test("parses a stored drop and refuses anything else", () => {
  expect(parseAgentDrop(JSON.stringify(drop))).toEqual(drop);
  expect(parseAgentDrop(null)).toBeNull();
  expect(parseAgentDrop("{")).toBeNull();
  expect(parseAgentDrop(JSON.stringify({ ...drop, known: [1] }))).toBeNull();
});
