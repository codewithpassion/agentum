import { expect, test } from "bun:test";
import { librarySyncScope } from "./sync-paths.ts";

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
