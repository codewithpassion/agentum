import { expect, test } from "bun:test";
import { newTitle } from "./thread-meta.ts";

test("a new title is the trimmed text", () => {
  expect(newTitle("  Quarterly plan ", "Old")).toBe("Quarterly plan");
});

test("an empty or unchanged title is not a rename", () => {
  expect(newTitle("   ", "Old")).toBeNull();
  expect(newTitle("Old ", "Old")).toBeNull();
});
