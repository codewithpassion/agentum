import { expect, test } from "bun:test";
import { LEARN_LEVELS } from "@repo/db/shared";
import {
  addRule,
  canChangeRules,
  LEARN_LEVEL_OPTIONS,
  MAX_RULE_CHARS,
  MAX_RULE_ENTRIES,
  neverRows,
  removeRule,
} from "./rules-logic.ts";

test("neverRows puts workspace rules first, all locked", () => {
  const rows = neverRows(["Passwords"], ["Salaries"]);
  expect(rows).toEqual([
    { locked: true, text: "Passwords" },
    { locked: false, text: "Salaries" },
  ]);
});

test("neverRows drops agent rules that repeat a workspace rule, ignoring case and spaces", () => {
  const rows = neverRows(["Passwords"], ["  passwords ", "Salaries"]);
  expect(rows).toEqual([
    { locked: true, text: "Passwords" },
    { locked: false, text: "Salaries" },
  ]);
});

test("neverRows keeps agent rules unlocked and in their order", () => {
  const rows = neverRows([], ["B rule", "A rule"]);
  expect(rows).toEqual([
    { locked: false, text: "B rule" },
    { locked: false, text: "A rule" },
  ]);
});

test("canChangeRules allows an admin, the owner and nobody else", () => {
  expect(
    canChangeRules({ isAdmin: true, ownerUserId: "u1", userId: "u2" })
  ).toBe(true);
  expect(
    canChangeRules({ isAdmin: false, ownerUserId: "u1", userId: "u1" })
  ).toBe(true);
  expect(
    canChangeRules({ isAdmin: false, ownerUserId: "u1", userId: "u2" })
  ).toBe(false);
  expect(
    canChangeRules({ isAdmin: false, ownerUserId: "u1", userId: null })
  ).toBe(false);
});

test("canChangeRules refuses a null user unless admin, even with no owner", () => {
  expect(
    canChangeRules({ isAdmin: false, ownerUserId: null, userId: null })
  ).toBe(false);
  expect(
    canChangeRules({ isAdmin: true, ownerUserId: null, userId: null })
  ).toBe(true);
});

test("addRule appends trimmed text without mutating the input", () => {
  const list = ["Keys"];
  const next = addRule(list, "  Bank details  ");
  expect(next).toEqual(["Keys", "Bank details"]);
  expect(list).toEqual(["Keys"]);
});

test("addRule rejects empty text after trimming", () => {
  expect(addRule(["Keys"], "   ")).toBeNull();
});

test("addRule rejects text longer than MAX_RULE_CHARS and accepts exactly that length", () => {
  expect(addRule([], "x".repeat(MAX_RULE_CHARS + 1))).toBeNull();
  expect(addRule([], "x".repeat(MAX_RULE_CHARS))).toEqual([
    "x".repeat(MAX_RULE_CHARS),
  ]);
});

test("addRule rejects a duplicate, ignoring case and surrounding spaces", () => {
  expect(addRule(["Keys"], " keys ")).toBeNull();
});

test("addRule rejects a new entry once the list holds MAX_RULE_ENTRIES", () => {
  const full = Array.from({ length: MAX_RULE_ENTRIES }, (_, i) => `rule ${i}`);
  expect(addRule(full, "one more")).toBeNull();
  expect(addRule(full.slice(1), "one more")).toHaveLength(MAX_RULE_ENTRIES);
});

test("removeRule drops the exact match and does not mutate", () => {
  const list = ["Keys", "Health"];
  expect(removeRule(list, "Keys")).toEqual(["Health"]);
  expect(list).toEqual(["Keys", "Health"]);
});

test("removeRule leaves the list alone when nothing matches exactly", () => {
  expect(removeRule(["Keys"], "keys")).toEqual(["Keys"]);
});

test("LEARN_LEVEL_OPTIONS covers every learn level in order with labels and hints", () => {
  expect(LEARN_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
    "ask_first",
    "tell_after",
    "quiet",
  ]);
  expect(LEARN_LEVEL_OPTIONS.map((option) => option.label)).toEqual([
    "Ask me first",
    "Tell me after",
    "Quietly",
  ]);
  expect(LEARN_LEVEL_OPTIONS.map((option) => option.hint)).toEqual([
    "Every new note waits for your approval.",
    "Notes apply at once and show under Learned this week.",
    "Notes apply at once and show only in the dream diary.",
  ]);
});

test("LEARN_LEVEL_OPTIONS values match LEARN_LEVELS exactly", () => {
  expect(LEARN_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
    ...LEARN_LEVELS,
  ]);
});
