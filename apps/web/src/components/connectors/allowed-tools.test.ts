import { describe, expect, test } from "bun:test";
import { extraToolNames, matchesToolFilter } from "./allowed-tools.ts";

const search = { description: "Search the docs", name: "search" };
const echo = { description: null, name: "echo" };
const write = { description: "Write a file", name: "write" };
const tools = [search, echo, write];

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
