import { describe, expect, test } from "bun:test";
import { treeRows, uploadPath, validNewFilePath } from "./skill-tree.ts";

describe("treeRows", () => {
  test("empty input gives no rows", () => {
    expect(treeRows([])).toEqual([]);
  });

  test("top-level files at depth 0", () => {
    expect(treeRows(["SKILL.md"])).toEqual([
      { depth: 0, kind: "file", name: "SKILL.md", path: "SKILL.md" },
    ]);
  });

  test("nested dirs come before their children and each dir appears once", () => {
    const rows = treeRows([
      "assets/img/logo.png",
      "assets/img/icon.svg",
      "assets/readme.txt",
    ]);
    expect(rows).toEqual([
      { depth: 0, kind: "dir", name: "assets", path: "assets" },
      { depth: 1, kind: "dir", name: "img", path: "assets/img" },
      { depth: 2, kind: "file", name: "icon.svg", path: "assets/img/icon.svg" },
      { depth: 2, kind: "file", name: "logo.png", path: "assets/img/logo.png" },
      { depth: 1, kind: "file", name: "readme.txt", path: "assets/readme.txt" },
    ]);
  });

  test("dirs before files at each level, each group sorted by code unit order", () => {
    const rows = treeRows([
      "b.md",
      "A.md",
      "z/x.ts",
      "a/y.ts",
      "_s.ts",
      "a.md",
    ]);
    expect(rows.map((row) => row.path)).toEqual([
      "a",
      "a/y.ts",
      "z",
      "z/x.ts",
      "A.md",
      "_s.ts",
      "a.md",
      "b.md",
    ]);
  });

  test("uses code unit order, not localeCompare", () => {
    // localeCompare would put "a" before "B"; code unit order puts "B" first.
    const rows = treeRows(["a.txt", "B.txt"]);
    expect(rows.map((row) => row.name)).toEqual(["B.txt", "a.txt"]);
  });

  test("shared dirs are emitted once, with files from all paths", () => {
    const rows = treeRows([
      "scripts/a.ts",
      "scripts/b.ts",
      "scripts/deep/c.ts",
    ]);
    expect(rows.filter((row) => row.kind === "dir")).toEqual([
      { depth: 0, kind: "dir", name: "scripts", path: "scripts" },
      { depth: 1, kind: "dir", name: "deep", path: "scripts/deep" },
    ]);
    expect(rows.filter((row) => row.kind === "file")).toHaveLength(3);
  });

  test("duplicate file paths produce one row", () => {
    expect(treeRows(["SKILL.md", "SKILL.md"])).toHaveLength(1);
  });
});

describe("validNewFilePath", () => {
  test("accepts plain and nested relative paths", () => {
    expect(validNewFilePath("SKILL.md")).toBeNull();
    expect(validNewFilePath("scripts/hello.ts")).toBeNull();
    expect(validNewFilePath("assets/img/logo.png")).toBeNull();
  });

  test("trims surrounding whitespace before checking", () => {
    expect(validNewFilePath("  scripts/hello.ts  ")).toBeNull();
  });

  test("rejects empty and whitespace-only input", () => {
    expect(validNewFilePath("")).not.toBeNull();
    expect(validNewFilePath("   ")).not.toBeNull();
  });

  test("rejects a leading slash or backslash", () => {
    expect(validNewFilePath("/etc/passwd")).not.toBeNull();
    expect(validNewFilePath("\\file.ts")).not.toBeNull();
    expect(validNewFilePath("  /file.ts")).not.toBeNull();
  });

  test("rejects a backslash anywhere", () => {
    expect(validNewFilePath("scripts\\hello.ts")).not.toBeNull();
  });

  test("rejects control characters", () => {
    expect(validNewFilePath("a\u0000b")).not.toBeNull();
    expect(validNewFilePath("a\tb")).not.toBeNull();
    expect(validNewFilePath("a\nb")).not.toBeNull();
    expect(validNewFilePath("a\u007fb")).not.toBeNull();
  });

  test("rejects empty segments", () => {
    expect(validNewFilePath("a//b.ts")).not.toBeNull();
  });

  test("rejects . and .. segments", () => {
    expect(validNewFilePath(".")).not.toBeNull();
    expect(validNewFilePath("..")).not.toBeNull();
    expect(validNewFilePath("../x.ts")).not.toBeNull();
    expect(validNewFilePath("a/./b.ts")).not.toBeNull();
    expect(validNewFilePath("a/../b.ts")).not.toBeNull();
  });

  test("accepts names that only contain dots", () => {
    expect(validNewFilePath("..notes")).toBeNull();
    expect(validNewFilePath("a/.hidden")).toBeNull();
  });

  test("rejects a trailing slash", () => {
    expect(validNewFilePath("scripts/")).not.toBeNull();
  });
});

describe("uploadPath", () => {
  test("uses the file name alone at the skill root", () => {
    expect(uploadPath("", "SKILL.md")).toBe("SKILL.md");
  });

  test("joins a dir and a file name with /", () => {
    expect(uploadPath("scripts", "hello.ts")).toBe("scripts/hello.ts");
    expect(uploadPath("assets/img", "logo.png")).toBe("assets/img/logo.png");
  });
});
