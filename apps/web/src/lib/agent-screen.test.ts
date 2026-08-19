import { describe, expect, test } from "bun:test";
import {
  breadcrumbsFor,
  joinPath,
  latestExec,
  looksBinary,
  mergeActivity,
  parentPath,
  toExecView,
} from "./agent-screen";
import type { ActivityView } from "./api";

const entry = (
  id: string,
  createdAt: number,
  overrides: Partial<ActivityView> = {}
): ActivityView => ({
  createdAt,
  detail: null,
  id,
  kind: "computer.write",
  summary: `wrote ${id}`,
  ...overrides,
});

describe("parentPath", () => {
  test("climbs one level", () => {
    expect(parentPath("/notes/today.md")).toBe("/notes");
    expect(parentPath("/notes/sub/")).toBe("/notes");
  });

  test("stops at the root", () => {
    expect(parentPath("/notes")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});

describe("joinPath", () => {
  test("never doubles the separator", () => {
    expect(joinPath("/", "notes.txt")).toBe("/notes.txt");
    expect(joinPath("/notes", "today.md")).toBe("/notes/today.md");
    expect(joinPath("/notes/", "today.md")).toBe("/notes/today.md");
  });
});

describe("breadcrumbsFor", () => {
  test("starts at the root and names each ancestor", () => {
    expect(breadcrumbsFor("/notes/sub")).toEqual([
      { label: "/", path: "/" },
      { label: "notes", path: "/notes" },
      { label: "sub", path: "/notes/sub" },
    ]);
  });

  test("is just the root at the root", () => {
    expect(breadcrumbsFor("/")).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("mergeActivity", () => {
  test("keeps one row per id and stays newest first", () => {
    const merged = mergeActivity(
      [entry("b", 200), entry("a", 100)],
      [entry("c", 300), entry("b", 200)]
    );
    expect(merged.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  test("breaks timestamp ties on id, the way the server does", () => {
    const merged = mergeActivity([], [entry("a", 100), entry("b", 100)]);
    expect(merged.map((row) => row.id)).toEqual(["b", "a"]);
  });

  test("lets a later page overwrite what it repeats", () => {
    const merged = mergeActivity(
      [entry("a", 100, { summary: "stale" })],
      [entry("a", 100, { summary: "fresh" })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.summary).toBe("fresh");
  });
});

describe("looksBinary", () => {
  test("spots content the UTF-8 read mangled", () => {
    expect(looksBinary("PNG��")).toBe(true);
    expect(looksBinary("head\0tail")).toBe(true);
  });

  test("passes plain text through", () => {
    expect(looksBinary("hello, world\n")).toBe(false);
  });
});

describe("toExecView", () => {
  test("narrows a successful run", () => {
    expect(
      toExecView(
        entry("a", 1, {
          detail: { command: "ls", exitCode: 0, stderr: "", stdout: "notes" },
          kind: "computer.exec",
        })
      )
    ).toEqual({
      command: "ls",
      error: null,
      exitCode: 0,
      stderr: "",
      stdout: "notes",
    });
  });

  test("narrows a run that never started", () => {
    const view = toExecView(
      entry("a", 1, {
        detail: { command: "ls", error: "no shell here" },
        kind: "computer.exec",
      })
    );
    expect(view?.error).toBe("no shell here");
    expect(view?.exitCode).toBeNull();
  });

  test("ignores rows of another kind, and exec rows with no command", () => {
    expect(toExecView(entry("a", 1, { detail: { command: "ls" } }))).toBeNull();
    expect(
      toExecView(entry("a", 1, { detail: {}, kind: "computer.exec" }))
    ).toBeNull();
  });
});

describe("latestExec", () => {
  test("takes the newest command out of a mixed page", () => {
    const exec = latestExec([
      entry("c", 300),
      entry("b", 200, {
        detail: { command: "echo hi", exitCode: 0 },
        kind: "computer.exec",
      }),
      entry("a", 100, {
        detail: { command: "older", exitCode: 0 },
        kind: "computer.exec",
      }),
    ]);
    expect(exec?.command).toBe("echo hi");
  });

  test("is null when nothing has been run", () => {
    expect(latestExec([entry("a", 100)])).toBeNull();
  });
});
