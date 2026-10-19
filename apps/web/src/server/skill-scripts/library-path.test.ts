import { describe, expect, test } from "bun:test";
import { libraryPathOf } from "./library-path.ts";

describe("libraryPathOf", () => {
  test("resolves a relative path in the home folder", () => {
    expect(libraryPathOf("agents/robo", "notes/today.md")).toBe(
      "agents/robo/notes/today.md"
    );
  });

  test("resolves .. inside the home folder", () => {
    expect(libraryPathOf("agents/robo", "../shared/a.ts")).toBe(
      "agents/shared/a.ts"
    );
  });

  test("resolves a relative path at the root when home is empty", () => {
    expect(libraryPathOf("", "a/b.ts")).toBe("a/b.ts");
  });

  test("keeps an absolute path under /library", () => {
    expect(libraryPathOf("agents/robo", "/library/a/b.ts")).toBe("a/b.ts");
  });

  test("maps /library itself to the root", () => {
    expect(libraryPathOf("agents/robo", "/library")).toBe("");
  });

  test("rejects an absolute path outside /library", () => {
    expect(() => libraryPathOf("agents/robo", "/etc/passwd")).toThrow(
      "Path is outside /library: /etc/passwd"
    );
  });

  test("rejects a path that only looks like /library", () => {
    expect(() => libraryPathOf("", "/library2/a")).toThrow(
      "Path is outside /library: /library2/a"
    );
  });

  test("keeps .. at the root", () => {
    expect(libraryPathOf("agents/robo", "../../../")).toBe("");
    expect(libraryPathOf("", "../../..")).toBe("");
  });
});
