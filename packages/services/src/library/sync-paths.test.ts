import { describe, expect, test } from "bun:test";
import { libraryPathsOf, librarySyncScope } from "./sync-paths.ts";

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
