import { describe, expect, test } from "bun:test";
import { headingAnchorIds, headingAnchors } from "./heading-anchors";

describe("headingAnchors", () => {
  test("reads every heading with its level, line and id", () => {
    const markdown = ["# Title", "", "text", "", "## Setup"].join("\n");
    expect(headingAnchors(markdown)).toEqual([
      { id: "title", level: 1, line: 1, text: "Title" },
      { id: "setup", level: 2, line: 5, text: "Setup" },
    ]);
  });

  test("dedupes repeated headings in document order", () => {
    const markdown = ["## Setup", "## Setup", "### Setup"].join("\n");
    expect(headingAnchors(markdown).map((anchor) => anchor.id)).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  test("drops closing hashes", () => {
    expect(headingAnchors("## Setup ##")[0]?.id).toBe("setup");
  });

  test("ignores hashes inside a fenced code block", () => {
    const markdown = ["```sh", "# not a heading", "```", "# Real"].join("\n");
    expect(headingAnchors(markdown)).toEqual([
      { id: "real", level: 1, line: 4, text: "Real" },
    ]);
  });

  test("ignores a hash that is not a heading", () => {
    expect(headingAnchors("issue #42 is open")).toEqual([]);
  });

  test("is stable across calls", () => {
    const markdown = "# Setup\n\n# Setup";
    expect(headingAnchors(markdown)).toEqual(headingAnchors(markdown));
  });
});

describe("headingAnchorIds", () => {
  test("maps source lines to ids", () => {
    expect([...headingAnchorIds("# One\n\n# One").entries()]).toEqual([
      [1, "one"],
      [3, "one-1"],
    ]);
  });
});
