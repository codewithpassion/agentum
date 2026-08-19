import { describe, expect, test } from "bun:test";
import {
  buildSnapshot,
  MAX_SNAPSHOT_LINKS,
  MAX_SNAPSHOT_TEXT_BYTES,
  type RawSnapshot,
  summarizeSnapshot,
} from "./snapshot";

const raw = (over: Partial<RawSnapshot> = {}): RawSnapshot => ({
  links: [],
  text: "Example Domain\n\nThis domain is for use in examples.",
  title: "Example Domain",
  url: "https://example.com/",
  ...over,
});

describe("buildSnapshot", () => {
  test("keeps a small page whole", () => {
    const snapshot = buildSnapshot(raw());
    expect(snapshot.text).toContain("Example Domain");
    expect(snapshot.textTruncated).toBe(false);
    expect(snapshot.linksTruncated).toBe(false);
  });

  test("tidies the title and link text but not the page text's paragraphs", () => {
    const snapshot = buildSnapshot(
      raw({
        links: [{ href: "https://example.com/a", text: "  More\n info  " }],
        title: "  Example   Domain\n",
      })
    );
    expect(snapshot.title).toBe("Example Domain");
    expect(snapshot.links[0]?.text).toBe("More info");
    expect(snapshot.text).toContain("\n\n");
  });

  test("truncates text over the cap and says so", () => {
    const snapshot = buildSnapshot(
      raw({ text: "x".repeat(MAX_SNAPSHOT_TEXT_BYTES + 100) })
    );
    expect(snapshot.textTruncated).toBe(true);
    expect(snapshot.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT_BYTES);
  });

  test("caps the link list and says so", () => {
    const links = Array.from({ length: MAX_SNAPSHOT_LINKS + 5 }, (_, i) => ({
      href: `https://example.com/${i}`,
      text: `link ${i}`,
    }));
    const snapshot = buildSnapshot(raw({ links }));
    expect(snapshot.links).toHaveLength(MAX_SNAPSHOT_LINKS);
    expect(snapshot.linksTruncated).toBe(true);
  });

  test("drops links with no href", () => {
    const snapshot = buildSnapshot(
      raw({
        links: [
          { href: "", text: "dead" },
          { href: "https://example.com/a", text: "live" },
        ],
      })
    );
    expect(snapshot.links).toEqual([
      { href: "https://example.com/a", text: "live" },
    ]);
  });
});

describe("summarizeSnapshot", () => {
  test("leads with the title and URL and counts the links", () => {
    const summary = summarizeSnapshot(
      buildSnapshot(
        raw({ links: [{ href: "https://example.com/a", text: "More" }] })
      )
    );
    expect(summary).toContain("Example Domain - https://example.com/");
    expect(summary).toContain("[1 links");
  });

  test("says so rather than showing an empty title", () => {
    const summary = summarizeSnapshot(buildSnapshot(raw({ title: "" })));
    expect(summary).toContain("(untitled)");
  });
});
