import { describe, expect, test } from "bun:test";
import {
  parseWikiLinks,
  replaceWikiLinks,
  wikiSlugFromHref,
} from "./wiki-links";

describe("parseWikiLinks", () => {
  test("finds a link and its slug", () => {
    expect(parseWikiLinks("see [[Getting Started]] first")).toEqual([
      { index: 4, slug: "getting-started", title: "Getting Started" },
    ]);
  });

  test("finds every link, including repeats", () => {
    const links = parseWikiLinks("[[One]] then [[Two]] then [[One]]");
    expect(links.map((link) => link.slug)).toEqual(["one", "two", "one"]);
  });

  test("trims the title inside the brackets", () => {
    expect(parseWikiLinks("[[  Release Notes  ]]")[0]).toEqual({
      index: 0,
      slug: "release-notes",
      title: "Release Notes",
    });
  });

  test("ignores empty and unterminated links", () => {
    expect(parseWikiLinks("[[ ]] and [[unclosed")).toEqual([]);
  });

  test("ignores ordinary markdown links", () => {
    expect(parseWikiLinks("[Getting Started](/wiki/getting-started)")).toEqual(
      []
    );
  });
});

describe("replaceWikiLinks", () => {
  test("rewrites a link into markdown", () => {
    expect(replaceWikiLinks("see [[Getting Started]]")).toBe(
      "see [Getting Started](/wiki/getting-started)"
    );
  });

  test("rewrites every link in a body", () => {
    expect(replaceWikiLinks("[[One]] and [[Two Words]]")).toBe(
      "[One](/wiki/one) and [Two Words](/wiki/two-words)"
    );
  });

  test("leaves other text untouched", () => {
    const body = "# Title\n\n[a](https://example.com) and [[ ]]";
    expect(replaceWikiLinks(body)).toBe(body);
  });
});

describe("wikiSlugFromHref", () => {
  test("reads the slug out of a wiki href", () => {
    expect(wikiSlugFromHref("/wiki/getting-started")).toBe("getting-started");
  });

  test("ignores a query string and a hash", () => {
    expect(wikiSlugFromHref("/wiki/setup?title=Setup#step-1")).toBe("setup");
  });

  test("returns null for anything else", () => {
    expect(wikiSlugFromHref("https://example.com")).toBeNull();
    expect(wikiSlugFromHref("#section")).toBeNull();
    expect(wikiSlugFromHref("/wiki/")).toBeNull();
  });
});
