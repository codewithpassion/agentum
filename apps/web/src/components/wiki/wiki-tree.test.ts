import { describe, expect, test } from "bun:test";
import type { WikiPageSummary } from "#/lib/api";
import { buildWikiTree, wikiFolderChildren, wikiNodeLabel } from "./wiki-tree";

const page = (slug: string, title: string): WikiPageSummary => ({
  id: slug,
  slug,
  title,
  updatedAt: 0,
});

describe("buildWikiTree", () => {
  test("keeps a flat wiki flat", () => {
    const tree = buildWikiTree([
      page("notes", "Notes"),
      page("setup", "Setup"),
    ]);
    expect(tree.map((node) => node.path)).toEqual(["notes", "setup"]);
    expect(tree[0]?.children).toEqual([]);
  });

  test("nests a page under the folders in its slug", () => {
    const [ops] = buildWikiTree([page("ops/runbooks/deploy", "Deploy")]);
    expect(ops?.path).toBe("ops");
    expect(ops?.page).toBeNull();
    const runbooks = ops?.children[0];
    expect(runbooks?.path).toBe("ops/runbooks");
    expect(runbooks?.children[0]?.page?.title).toBe("Deploy");
  });

  test("a node can be both a page and a folder", () => {
    const tree = buildWikiTree([
      page("ops/deploy", "Deploy"),
      page("ops", "Ops"),
    ]);
    expect(
      tree.map((node) => ({
        children: node.children.map((child) => child.path),
        title: node.page?.title,
      }))
    ).toEqual([{ children: ["ops/deploy"], title: "Ops" }]);
  });

  test("dedupes folders shared by sibling pages", () => {
    const [ops] = buildWikiTree([
      page("ops/deploy", "Deploy"),
      page("ops/rollback", "Rollback"),
    ]);
    expect(ops?.children).toHaveLength(2);
  });

  test("sorts children by label at every level", () => {
    const tree = buildWikiTree([
      page("ops/zulu", "Zulu"),
      page("ops/alpha", "Alpha"),
      page("guides/intro", "Intro"),
    ]);
    expect(
      tree.map((node) => [
        wikiNodeLabel(node),
        node.children.map(wikiNodeLabel),
      ])
    ).toEqual([
      ["guides", ["Intro"]],
      ["ops", ["Alpha", "Zulu"]],
    ]);
  });

  test("labels a folder with its segment and a page with its title", () => {
    const tree = buildWikiTree([page("ops/deploy-the-app", "Deploy the App")]);
    expect(
      tree.map((node) => [
        wikiNodeLabel(node),
        node.children.map(wikiNodeLabel),
      ])
    ).toEqual([["ops", ["Deploy the App"]]]);
  });
});

describe("wikiFolderChildren", () => {
  const pages = [
    page("ops/runbooks/deploy", "Deploy"),
    page("ops/oncall", "Oncall"),
    page("ops-notes", "Ops Notes"),
  ];

  test("lists the direct children of a folder", () => {
    expect(wikiFolderChildren(pages, "ops").map((node) => node.path)).toEqual([
      "ops/oncall",
      "ops/runbooks",
    ]);
  });

  test("does not treat a same-prefix sibling as a child", () => {
    expect(
      wikiFolderChildren(pages, "ops").map((node) => node.path)
    ).not.toContain("ops-notes");
  });

  test("returns nothing for a path with no descendants", () => {
    expect(wikiFolderChildren(pages, "ops/oncall")).toEqual([]);
    expect(wikiFolderChildren(pages, "nowhere")).toEqual([]);
  });
});
