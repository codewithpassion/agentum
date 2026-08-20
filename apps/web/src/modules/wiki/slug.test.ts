import { describe, expect, test } from "bun:test";
import {
  createHeadingSlugger,
  EMPTY_SLUG_FALLBACK,
  leafTitle,
  slugify,
  slugifyPath,
} from "./slug";

describe("slugify", () => {
  test("lowercases and dashes a title", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
  });

  test("drops punctuation", () => {
    expect(slugify("What's new? (2026)")).toBe("whats-new-2026");
  });

  test("collapses runs of spaces, dashes and underscores", () => {
    expect(slugify("Deploy   the __ app -- now")).toBe("deploy-the-app-now");
  });

  test("trims leading and trailing dashes", () => {
    expect(slugify("  -- Release notes --  ")).toBe("release-notes");
  });

  test("keeps non-latin letters and digits", () => {
    expect(slugify("Wörter über Zahlen 42")).toBe("worter-uber-zahlen-42");
  });

  test("falls back when a title has no slug characters", () => {
    expect(slugify("!!!")).toBe(EMPTY_SLUG_FALLBACK);
  });
});

describe("slugifyPath", () => {
  test("slugs each segment and keeps the separators", () => {
    expect(slugifyPath("Ops/Runbooks/Deploy the App")).toBe(
      "ops/runbooks/deploy-the-app"
    );
  });

  test("matches slugify when there is no path", () => {
    expect(slugifyPath("Getting Started")).toBe("getting-started");
  });

  test("drops empty segments", () => {
    expect(slugifyPath("a//b")).toBe("a/b");
    expect(slugifyPath("/ops/runbooks/")).toBe("ops/runbooks");
    expect(slugifyPath("ops/   /deploy")).toBe("ops/deploy");
  });

  test("falls back per segment for punctuation-only names", () => {
    expect(slugifyPath("!!!/Notes")).toBe(`${EMPTY_SLUG_FALLBACK}/notes`);
  });

  test("falls back when nothing is left", () => {
    expect(slugifyPath("///")).toBe(EMPTY_SLUG_FALLBACK);
  });
});

describe("leafTitle", () => {
  test("keeps a title without a path", () => {
    expect(leafTitle("Getting Started")).toBe("Getting Started");
  });

  test("takes the last segment of a path title", () => {
    expect(leafTitle("Ops/Runbooks/Deploy")).toBe("Deploy");
  });

  test("trims the segment and ignores trailing separators", () => {
    expect(leafTitle("Ops / Runbooks /")).toBe("Runbooks");
  });
});

describe("createHeadingSlugger", () => {
  test("leaves the first occurrence unsuffixed and numbers the rest", () => {
    const slugger = createHeadingSlugger();
    expect(slugger("Setup")).toBe("setup");
    expect(slugger("Setup")).toBe("setup-1");
    expect(slugger("Setup")).toBe("setup-2");
  });

  test("counts per heading text", () => {
    const slugger = createHeadingSlugger();
    expect(slugger("Notes")).toBe("notes");
    expect(slugger("Other")).toBe("other");
    expect(slugger("Notes")).toBe("notes-1");
  });

  test("dedupes across titles that slug to the same value", () => {
    const slugger = createHeadingSlugger();
    expect(slugger("Setup!")).toBe("setup");
    expect(slugger("setup")).toBe("setup-1");
  });

  test("starts fresh per slugger", () => {
    expect(createHeadingSlugger()("Setup")).toBe("setup");
    expect(createHeadingSlugger()("Setup")).toBe("setup");
  });
});
