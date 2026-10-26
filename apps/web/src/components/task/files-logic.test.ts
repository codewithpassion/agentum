import { expect, test } from "bun:test";
import {
  fileEntries,
  fileTime,
  outsideTag,
  relativeToFolder,
} from "./files-logic.ts";

test("a path under the folder loses the folder prefix", () => {
  expect(
    relativeToFolder(
      "agents/a/tasks/run_1/notes/todo.md",
      "agents/a/tasks/run_1"
    )
  ).toBe("notes/todo.md");
});

test("a path not under the folder is returned unchanged", () => {
  expect(relativeToFolder("agents/b/x.txt", "agents/a/tasks/run_1")).toBe(
    "agents/b/x.txt"
  );
});

test("a folder that is only a name prefix of another does not match", () => {
  expect(
    relativeToFolder("agents/a/tasks/run_10/x.txt", "agents/a/tasks/run_1")
  ).toBe("agents/a/tasks/run_10/x.txt");
});

test("each edit op has its own tag with the version", () => {
  expect(outsideTag("write", 12)).toBe("edited · v12");
  expect(outsideTag("delete", 12)).toBe("deleted · v12");
  expect(outsideTag("restore", 12)).toBe("restored · v12");
  expect(outsideTag("move", 12)).toBe("moved · v12");
});

test("a file time is its HH:MM part, read as stored", () => {
  expect(fileTime("2026-10-27T10:01:30.000Z")).toBe("10:01");
  expect(fileTime("2026-10-27T23:59:00.000Z")).toBe("23:59");
});

test("the file entries keep only files, in order", () => {
  const entries = [
    { kind: "dir" as const, path: "a" },
    { kind: "file" as const, path: "b.txt" },
    { kind: "file" as const, path: "c.txt" },
    { kind: "dir" as const, path: "d" },
  ];
  expect(fileEntries(entries).map((entry) => entry.path)).toEqual([
    "b.txt",
    "c.txt",
  ]);
  expect(fileEntries([])).toEqual([]);
});
