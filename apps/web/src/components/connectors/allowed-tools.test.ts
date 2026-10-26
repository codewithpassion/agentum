import { describe, expect, test } from "bun:test";
import {
  extraToolNames,
  matchesToolFilter,
  toolAccessLabel,
} from "./allowed-tools.ts";

const search = { description: "Search the docs", name: "search" };
const echo = { description: null, name: "echo" };
const write = { description: "Write a file", name: "write" };
const tools = [search, echo, write];

describe("toolAccessLabel", () => {
  test("null allowlist means all tools", () => {
    expect(toolAccessLabel(null, tools)).toBe("All tools");
  });

  test("counts only allowed names that are cached", () => {
    expect(toolAccessLabel(["echo", "search"], tools)).toBe(
      "2 of 3 tools allowed"
    );
    expect(toolAccessLabel(["gone"], tools)).toBe("0 of 3 tools allowed");
  });

  test("without a cached list, counts the stored names", () => {
    expect(toolAccessLabel(["echo"], [])).toBe("1 tools allowed");
  });
});

describe("extraToolNames", () => {
  test("returns allowlisted names missing from the cache", () => {
    expect(extraToolNames(["echo", "gone"], tools)).toEqual(["gone"]);
  });

  test("is empty for null or fully cached lists", () => {
    expect(extraToolNames(null, tools)).toEqual([]);
    expect(extraToolNames(["echo"], tools)).toEqual([]);
  });
});

describe("matchesToolFilter", () => {
  test("empty filter matches everything", () => {
    expect(matchesToolFilter(echo, "  ")).toBe(true);
  });

  test("matches name or description, ignoring case", () => {
    expect(matchesToolFilter(search, "DOCS")).toBe(true);
    expect(matchesToolFilter(echo, "file")).toBe(false);
    expect(matchesToolFilter(write, "file")).toBe(true);
    expect(matchesToolFilter(echo, "ECH")).toBe(true);
  });
});
