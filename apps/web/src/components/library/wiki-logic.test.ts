import { expect, test } from "bun:test";
import type {
  WikiPageNodeRecord,
  WikiPageRecord,
} from "#/integrations/trpc/types";
import {
  flattenWikiTree,
  isWikiPage,
  libraryTarget,
  wikiLinkChip,
  wikiParentOptions,
} from "./wiki-logic.ts";

const node = (
  path: string,
  title: string,
  children: WikiPageNodeRecord[] = []
): WikiPageNodeRecord => ({ children, path, title });

const tree = [
  node("wiki/company.md", "Company", [
    node("wiki/company/finance.md", "Finance", [
      node("wiki/company/finance/month-end.md", "Month-end"),
    ]),
    node("wiki/company/ops", "ops", [
      node("wiki/company/ops/inbox.md", "Inbox"),
    ]),
  ]),
  node("wiki/welcome.md", "Welcome"),
];

test("flattenWikiTree lists pages and folders in reading order with depth", () => {
  expect(
    flattenWikiTree(tree).map((row) => [row.node.title, row.depth, row.isPage])
  ).toEqual([
    ["Company", 0, true],
    ["Finance", 1, true],
    ["Month-end", 2, true],
    ["ops", 1, false],
    ["Inbox", 2, true],
    ["Welcome", 0, true],
  ]);
});

test("flattenWikiTree of nothing is empty", () => {
  expect(flattenWikiTree([])).toEqual([]);
});

test("isWikiPage accepts only wiki markdown files", () => {
  expect(isWikiPage("wiki/a.md")).toBe(true);
  expect(isWikiPage("wiki/a")).toBe(false);
  expect(isWikiPage("files/a.md")).toBe(false);
});

test("wikiParentOptions starts at the top level and indents by depth", () => {
  const options = wikiParentOptions(tree);
  expect(options[0]).toEqual({ label: "Top level", value: "" });
  expect(options.map((option) => option.value)).toContain(
    "wiki/company/finance.md"
  );
  const month = options.find(
    (option) => option.value === "wiki/company/finance/month-end.md"
  );
  expect(month?.label.endsWith("Month-end")).toBe(true);
  expect(month?.label.length).toBeGreaterThan("Month-end".length);
});

const links: WikiPageRecord["links"] = [
  {
    broken: false,
    index: 0,
    path: "wiki/finance/month-end.md",
    slug: "finance/month-end",
    title: "Finance/Month-end",
  },
  {
    broken: true,
    index: 10,
    path: "wiki/supplier-onboarding.md",
    slug: "supplier-onboarding",
    title: "Supplier onboarding",
  },
];

test("wikiLinkChip marks a link to an existing page live", () => {
  expect(wikiLinkChip("/wiki/finance/month-end", links)).toEqual({
    broken: false,
    kind: "wiki",
    path: "wiki/finance/month-end.md",
    title: "Finance/Month-end",
  });
});

test("wikiLinkChip marks a link to a missing page broken", () => {
  expect(wikiLinkChip("/wiki/supplier-onboarding", links)).toMatchObject({
    broken: true,
    path: "wiki/supplier-onboarding.md",
  });
});

test("wikiLinkChip treats an unknown wiki slug as broken", () => {
  expect(wikiLinkChip("/wiki/nowhere", links)).toEqual({
    broken: true,
    kind: "wiki",
    path: "wiki/nowhere.md",
    title: "nowhere",
  });
});

test("wikiLinkChip leaves other hrefs as external", () => {
  expect(wikiLinkChip("https://example.com", links)).toEqual({
    kind: "external",
  });
  expect(wikiLinkChip(undefined, links)).toEqual({ kind: "external" });
});

test("libraryTarget opens wiki pages as pages and other paths as files", () => {
  expect(libraryTarget("wiki/a/b.md")).toEqual({ wiki: "wiki/a/b.md" });
  expect(libraryTarget("files/x.xlsx")).toEqual({
    dir: "files",
    file: "files/x.xlsx",
  });
  expect(libraryTarget("notes.txt")).toEqual({
    dir: undefined,
    file: "notes.txt",
  });
});
