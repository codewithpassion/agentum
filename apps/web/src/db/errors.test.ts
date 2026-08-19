import { describe, expect, test } from "bun:test";
import { isUniqueConstraintError } from "./errors";

describe("isUniqueConstraintError", () => {
  test("finds the constraint message nested in the cause chain", () => {
    const root = new Error(
      "UNIQUE constraint failed: agents.name: SQLITE_CONSTRAINT"
    );
    const wrapped = new Error("D1_ERROR", { cause: root });
    const drizzle = new Error("Failed query: insert into ...", {
      cause: wrapped,
    });
    expect(isUniqueConstraintError(drizzle)).toBe(true);
  });

  test("is false for an unrelated error", () => {
    expect(isUniqueConstraintError(new Error("no such table"))).toBe(false);
  });

  test("is false for a non-error value", () => {
    expect(isUniqueConstraintError("boom")).toBe(false);
  });

  test("stops walking a self-referential cause chain", () => {
    const looping = new Error("boom");
    looping.cause = looping;
    expect(isUniqueConstraintError(looping)).toBe(false);
  });
});
