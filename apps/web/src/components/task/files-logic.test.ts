import { expect, test } from "bun:test";
import type { Viewer } from "#/lib/time.ts";
import {
  fileEntries,
  fileTime,
  outsideTag,
  relativeToFolder,
} from "./files-logic.ts";

const SYDNEY: Viewer = { locale: "en-AU", timeZone: "Australia/Sydney" };
const UTC: Viewer = { locale: "en-GB", timeZone: "UTC" };

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

test("a file time shows the clock in the viewer's zone", () => {
  expect(fileTime("2026-10-27T10:01:30.000Z", SYDNEY)).toBe("9:01 pm");
  expect(fileTime("2026-10-27T23:59:00.000Z", SYDNEY)).toBe("10:59 am");
});

test("a file time for a UTC viewer is the stored UTC clock", () => {
  expect(fileTime("2026-10-27T10:01:30.000Z", UTC)).toBe("10:01");
  expect(fileTime("2026-10-27T23:59:00.000Z", UTC)).toBe("23:59");
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
