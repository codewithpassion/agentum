import { describe, expect, test } from "bun:test";
import { ServiceError } from "../errors.ts";
import {
  assertSafePath,
  assertTreeShape,
  SKILL_PATH_MAX_BYTES,
  SKILL_PATH_MAX_SEGMENTS,
} from "./paths.ts";

const refusal = (fn: () => void): ServiceError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("assertSafePath", () => {
  test.each([
    "SKILL.md",
    "scripts/run.sh",
    "references/a/b.md",
    "assets/naïve file.txt",
  ])("accepts %p", (path) => {
    expect(() => assertSafePath(path)).not.toThrow();
  });

  test("accepts a path of exactly the segment and byte limits", () => {
    const twentySegments = Array.from(
      { length: SKILL_PATH_MAX_SEGMENTS },
      () => "a"
    ).join("/");
    expect(() => assertSafePath(twentySegments)).not.toThrow();
    expect(() =>
      assertSafePath("a".repeat(SKILL_PATH_MAX_BYTES))
    ).not.toThrow();
  });

  test("refuses an empty path", () => {
    expect(refusal(() => assertSafePath("")).message).toBe(
      "Skill path must not be empty"
    );
  });

  test("refuses an absolute path", () => {
    expect(refusal(() => assertSafePath("/etc/passwd")).message).toBe(
      "Skill path must be relative"
    );
  });

  test("refuses a backslash", () => {
    expect(refusal(() => assertSafePath("a\\b")).message).toBe(
      "Skill path must use / and no backslashes"
    );
  });

  test.each([
    ["a//b", "double slash"],
    ["a/", "trailing slash"],
    ["./a", "leading dot"],
    ["a/./b", "middle dot"],
    ["../a", "leading dot dot"],
    ["a/../b", "middle dot dot"],
    ["a/..", "trailing dot dot"],
  ])("refuses %p (%s)", (path) => {
    expect(refusal(() => assertSafePath(path)).message).toBe(
      "Skill path has an empty or dot segment"
    );
  });

  test.each(["a\u0000b", "a\nb"])("refuses control character in %p", (path) => {
    expect(refusal(() => assertSafePath(path)).message).toBe(
      "Skill path must not contain control characters"
    );
  });

  test("refuses a path of one byte over the limit", () => {
    expect(
      refusal(() => assertSafePath("a".repeat(SKILL_PATH_MAX_BYTES + 1)))
        .message
    ).toBe(`Skill path must be at most ${SKILL_PATH_MAX_BYTES} bytes`);
  });

  test("counts bytes, not characters", () => {
    // 256 two-byte characters plus one ASCII byte: 257 characters, 513 bytes.
    const path = `${"é".repeat(256)}a`;
    expect(path.length).toBe(257);
    expect(refusal(() => assertSafePath(path)).message).toBe(
      `Skill path must be at most ${SKILL_PATH_MAX_BYTES} bytes`
    );
  });

  test("refuses one segment over the limit", () => {
    const path = Array.from(
      { length: SKILL_PATH_MAX_SEGMENTS + 1 },
      () => "a"
    ).join("/");
    expect(refusal(() => assertSafePath(path)).message).toBe(
      `Skill path must have at most ${SKILL_PATH_MAX_SEGMENTS} segments`
    );
  });

  test("refuses with the invalid code", () => {
    expect(refusal(() => assertSafePath("")).code).toBe("invalid");
  });
});

describe("assertTreeShape", () => {
  test("accepts a normal tree", () => {
    expect(() =>
      assertTreeShape(["SKILL.md", "scripts/run.sh", "references/a/b.md"])
    ).not.toThrow();
  });

  test("accepts an empty list", () => {
    expect(() => assertTreeShape([])).not.toThrow();
  });

  test("refuses a duplicate path", () => {
    expect(
      refusal(() => assertTreeShape(["a.md", "b.md", "a.md"])).message
    ).toBe('Skill path "a.md" appears twice');
  });

  test.each([[["a/b", "a/b/c"]], [["a/b/c", "a/b"]]])(
    "refuses a file that is also a folder: %p",
    (paths) => {
      expect(refusal(() => assertTreeShape(paths)).message).toBe(
        'Skill path "a/b" is both a file and a folder'
      );
    }
  );

  test("accepts a file whose name starts like another file", () => {
    expect(() => assertTreeShape(["a/b", "a/bc"])).not.toThrow();
  });
});
