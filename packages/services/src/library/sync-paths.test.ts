import { describe, expect, test } from "bun:test";
import {
  LIBRARY_PATHS_KEY,
  libraryPathsError,
  libraryPathsOf,
  librarySyncRoots,
} from "./sync-paths.ts";

const NOT_A_LIST = /must be a list/;
const LEAVES_LIBRARY = /not valid.*leaves the library/;
const WHOLE_LIBRARY = /cannot be the whole library/;

describe("libraryPathsError", () => {
  test("accepts a list of paths and an absent key", () => {
    expect(LIBRARY_PATHS_KEY).toBe("libraryPaths");
    expect(libraryPathsError({})).toBeUndefined();
    expect(
      libraryPathsError({ libraryPaths: ["projects/alpha", "notes.md"] })
    ).toBeUndefined();
    expect(libraryPathsError({ libraryPaths: [] })).toBeUndefined();
  });

  test("refuses a value that is not a list", () => {
    expect(libraryPathsError({ libraryPaths: "projects" })).toMatch(NOT_A_LIST);
    expect(libraryPathsError({ libraryPaths: null })).toMatch(NOT_A_LIST);
  });

  test("refuses items that are not non-empty strings", () => {
    expect(libraryPathsError({ libraryPaths: [3] })).toMatch(NOT_A_LIST);
    expect(libraryPathsError({ libraryPaths: ["a", ""] })).toMatch(NOT_A_LIST);
    expect(libraryPathsError({ libraryPaths: [{ path: "a" }] })).toMatch(
      NOT_A_LIST
    );
  });

  test("refuses a path that leaves the library", () => {
    expect(libraryPathsError({ libraryPaths: ["../secrets"] })).toMatch(
      LEAVES_LIBRARY
    );
  });

  test("refuses a path that normalises to the whole library", () => {
    for (const raw of ["/", ".", "a/..", "./"]) {
      expect(libraryPathsError({ libraryPaths: [raw] })).toMatch(WHOLE_LIBRARY);
    }
  });
});

describe("libraryPathsOf", () => {
  test("is empty when the key is absent or not a list", () => {
    expect(libraryPathsOf({})).toEqual([]);
    expect(libraryPathsOf({ libraryPaths: "projects" })).toEqual([]);
  });

  test("normalises, de-duplicates and keeps the order", () => {
    expect(
      libraryPathsOf({
        libraryPaths: [
          "/notes/",
          "projects/alpha",
          "notes",
          "./projects//alpha",
        ],
      })
    ).toEqual(["notes", "projects/alpha"]);
  });

  test("leaves out invalid entries instead of throwing", () => {
    expect(
      libraryPathsOf({
        libraryPaths: ["../outside", "", 7, "/", "docs/a/../b"],
      })
    ).toEqual(["docs/b"]);
    expect(libraryPathsOf({ libraryPaths: ["../outside", 7] })).toEqual([]);
  });
});

describe("librarySyncRoots", () => {
  test("the agent's own folder is always first", () => {
    expect(librarySyncRoots("ada", {})).toEqual(["agents/ada"]);
    expect(
      librarySyncRoots("ada", { libraryPaths: ["projects/alpha", "notes"] })
    ).toEqual(["agents/ada", "projects/alpha", "notes"]);
  });

  test("duplicates of the agent's folder are merged", () => {
    expect(
      librarySyncRoots("ada", { libraryPaths: ["agents/ada", "agents/ada/"] })
    ).toEqual(["agents/ada"]);
  });

  test("a root inside another root is dropped, the shorter one wins", () => {
    expect(
      librarySyncRoots("ada", { libraryPaths: ["agents/ada/notes", "notes"] })
    ).toEqual(["agents/ada", "notes"]);
    expect(
      librarySyncRoots("ada", { libraryPaths: ["docs", "docs/api/v2"] })
    ).toEqual(["agents/ada", "docs"]);
  });

  test("a library path that holds the agent's folder replaces it", () => {
    expect(librarySyncRoots("ada", { libraryPaths: ["agents"] })).toEqual([
      "agents",
    ]);
  });

  test("a path that only shares a name prefix is not nested", () => {
    expect(
      librarySyncRoots("ada", { libraryPaths: ["agents/ada-two"] })
    ).toEqual(["agents/ada", "agents/ada-two"]);
  });
});
