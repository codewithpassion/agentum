import { expect, test } from "bun:test";
import {
  isMemoryPath,
  mayReadMemoryPath,
  memoryFolderOf,
  privateMemoryOwner,
} from "./memory-paths.ts";

test("isMemoryPath matches the memory folder and everything under it", () => {
  expect(isMemoryPath("agents/scout/memory")).toBe(true);
  expect(isMemoryPath("agents/scout/memory/people.md")).toBe(true);
  expect(isMemoryPath("agents/scout/memory/private/user_1.md")).toBe(true);
  expect(isMemoryPath("agents/scout")).toBe(false);
  expect(isMemoryPath("agents/scout/memory2/people.md")).toBe(false);
  expect(isMemoryPath("agents/scout/notes/memory/people.md")).toBe(false);
  expect(isMemoryPath("wiki/memory/people.md")).toBe(false);
  expect(memoryFolderOf("scout")).toBe("agents/scout/memory");
});

test("privateMemoryOwner names the person a private file belongs to", () => {
  expect(privateMemoryOwner("agents/scout/memory/private/user_1.md")).toBe(
    "user_1"
  );
  expect(privateMemoryOwner("agents/scout/memory/private")).toBeNull();
  expect(privateMemoryOwner("agents/scout/memory/people.md")).toBeNull();
  expect(privateMemoryOwner("agents/scout/other.md")).toBeNull();
});

test("a stray path under private belongs to nobody", () => {
  expect(privateMemoryOwner("agents/scout/memory/private/notes.txt")).toBe("");
  expect(privateMemoryOwner("agents/scout/memory/private/.md")).toBe("");
  expect(privateMemoryOwner("agents/scout/memory/private/sub/user_1.md")).toBe(
    ""
  );
});

test("mayReadMemoryPath lets only the owner read a private file", () => {
  const file = "agents/scout/memory/private/user_1.md";
  expect(mayReadMemoryPath(file, "user_1")).toBe(true);
  expect(mayReadMemoryPath(file, "user_2")).toBe(false);
  expect(mayReadMemoryPath(file, null)).toBe(false);
  expect(mayReadMemoryPath("agents/scout/memory/people.md", null)).toBe(true);
  expect(mayReadMemoryPath("agents/scout/memory/private", null)).toBe(true);
  expect(mayReadMemoryPath("agents/scout/memory/private/x.txt", "")).toBe(
    false
  );
});
