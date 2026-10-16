import { expect, test } from "bun:test";
import { duplicateNameClientIds } from "./duplicates.ts";

test("flags every app whose name matches another's, ignoring case", () => {
  const duplicates = duplicateNameClientIds([
    { clientId: "real", name: "Claude" },
    { clientId: "cased", name: "claude" },
    { clientId: "other", name: "Cursor" },
  ]);
  expect([...duplicates].sort()).toEqual(["cased", "real"]);
});

test("a unique name and apps without a name are never flagged", () => {
  expect(
    duplicateNameClientIds([
      { clientId: "a", name: "Claude" },
      { clientId: "b", name: null },
      { clientId: "c", name: null },
    ]).size
  ).toBe(0);
});
