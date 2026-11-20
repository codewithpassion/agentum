import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { entries } from "./entries.ts";

const DOCUMENTED_ENTRY =
  /\/\/[^\n]*https:\/\/[^\s]+[^\n]*\n\s*\{[^{}]*?\bkey: "([^"]+)"/g;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const READ_ONLY_TOOL =
  /^(?:get_|list_|search_|notion-search$|notion-fetch$|slack_read_|slack_search_)/;

test("entries have unique keys, https endpoints, icons and explicit read-only defaults", () => {
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.length).toBeLessThanOrEqual(10);
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  for (const entry of entries) {
    expect(entry.key).toMatch(SLUG);
    expect(entry.icon).toMatch(SLUG);
    expect(new URL(entry.url).protocol).toBe("https:");
    expect(entry.defaultAllowedTools.length).toBeGreaterThan(0);
    for (const tool of entry.defaultAllowedTools) {
      expect(tool).toMatch(READ_ONLY_TOOL);
    }
  }
});

test("each entry has a vendor documentation URL directly above it", () => {
  const source = readFileSync(new URL("./entries.ts", import.meta.url), "utf8");
  const documentedKeys = [...source.matchAll(DOCUMENTED_ENTRY)].map(
    (match) => match[1]
  );
  expect(documentedKeys).toEqual(entries.map((entry) => entry.key));
});
