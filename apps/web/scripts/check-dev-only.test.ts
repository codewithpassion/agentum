import { describe, expect, test } from "bun:test";
import {
  SLOW_READ_COUNT_KEY,
  SLOW_READ_TOOL,
} from "../src/server/pi-run-dev-tools.ts";
import { findDevOnly } from "./check-dev-only.ts";

describe("findDevOnly", () => {
  test("a clean file set gives no paths", () => {
    expect(
      findDevOnly([
        { path: "dist/server/index.js", text: "export const x = 1;" },
        { path: "dist/server/chunk.mjs", text: "const y = 'pi-run';" },
      ])
    ).toEqual([]);
  });

  test("a file with the tool name is reported", () => {
    expect(
      findDevOnly([
        { path: "dist/server/a.js", text: `name: "${SLOW_READ_TOOL}"` },
      ])
    ).toEqual(["dist/server/a.js"]);
  });

  test("a file with the storage key is reported", () => {
    expect(
      findDevOnly([
        { path: "dist/server/b.json", text: `"${SLOW_READ_COUNT_KEY}"` },
      ])
    ).toEqual(["dist/server/b.json"]);
  });

  test("only the offending paths are returned", () => {
    expect(
      findDevOnly([
        { path: "dist/server/clean.js", text: "nothing here" },
        { path: "dist/server/dirty.js", text: `x(${SLOW_READ_TOOL})` },
        { path: "dist/server/also.mjs", text: "ok" },
        { path: "dist/server/key.js", text: SLOW_READ_COUNT_KEY },
      ])
    ).toEqual(["dist/server/dirty.js", "dist/server/key.js"]);
  });
});
