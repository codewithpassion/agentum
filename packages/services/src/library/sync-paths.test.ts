import { describe, expect, test } from "bun:test";
import {
  libraryPathsOf,
  librarySyncRoots,
  librarySyncScope,
} from "./sync-paths.ts";

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

test("scope preserves nested write exceptions", () => {
  expect(
    librarySyncScope("ada", [
      { mode: "read", path: "docs" },
      { mode: "read", path: "docs/api" },
      { mode: "write", path: "docs/edit" },
    ])
  ).toEqual([
    { mode: "write", path: "agents/ada" },
    { mode: "read", path: "wiki" },
    { mode: "read", path: "docs" },
    { mode: "write", path: "docs/edit" },
  ]);
});
