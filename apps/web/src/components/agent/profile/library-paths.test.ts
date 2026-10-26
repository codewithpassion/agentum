import { describe, expect, test } from "bun:test";
import { nextLibraryPaths, withoutPath } from "./library-paths.ts";

describe("nextLibraryPaths", () => {
  test("adds a path to the end of the list", () => {
    expect(nextLibraryPaths(["finance"], "wiki/Finance")).toEqual({
      paths: ["finance", "wiki/Finance"],
    });
  });

  test("trims the input before adding", () => {
    expect(nextLibraryPaths([], "  finance/  ")).toEqual({
      paths: ["finance"],
    });
  });

  test("treats a repeat with a different spelling as a duplicate", () => {
    expect(nextLibraryPaths(["finance"], "finance/")).toEqual({
      paths: ["finance"],
    });
  });

  test("refuses a path that leaves the library", () => {
    const result = nextLibraryPaths(["finance"], "../x");
    expect("error" in result).toBe(true);
    expect("paths" in result).toBe(false);
  });

  test("refuses empty input", () => {
    expect(nextLibraryPaths(["finance"], "   ")).toEqual({
      error: "Type a folder or file path.",
    });
  });

  test("refuses the whole library", () => {
    expect("error" in nextLibraryPaths([], "/")).toBe(true);
  });
});

describe("withoutPath", () => {
  test("removes the given path and keeps the order of the rest", () => {
    expect(
      withoutPath(["finance", "wiki/Finance", "wiki/Company"], "wiki/Finance")
    ).toEqual(["finance", "wiki/Company"]);
  });
});
