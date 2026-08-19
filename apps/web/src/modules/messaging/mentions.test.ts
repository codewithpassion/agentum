import { describe, expect, test } from "bun:test";
import { parseMentions } from "./mentions";

const candidates = [
  { id: "cos", name: "Chief of Staff" },
  { id: "chief", name: "Chief" },
  { id: "bob", name: "Bob" },
];

describe("parseMentions", () => {
  test("matches a multi-word agent name", () => {
    expect(parseMentions("hello @Chief of Staff", candidates)).toEqual([
      { id: "cos", index: 6, name: "Chief of Staff" },
    ]);
  });

  test("prefers the longest matching name", () => {
    const parsed = parseMentions("@Chief of Staff please help", candidates);
    expect(parsed.map((mention) => mention.id)).toEqual(["cos"]);
  });

  test("still matches the shorter name on its own", () => {
    expect(parseMentions("ping @Chief now", candidates)).toEqual([
      { id: "chief", index: 5, name: "Chief" },
    ]);
  });

  test("is case insensitive", () => {
    expect(parseMentions("@chief OF staff", candidates)).toEqual([
      { id: "cos", index: 0, name: "Chief of Staff" },
    ]);
  });

  test("ignores a name glued to a longer word", () => {
    expect(parseMentions("hey @Bobby", candidates)).toEqual([]);
  });

  test("ignores email addresses", () => {
    expect(parseMentions("write to bob@chief.example", candidates)).toEqual([]);
  });

  test("allows trailing punctuation after a mention", () => {
    expect(parseMentions("thanks @Bob!", candidates)).toEqual([
      { id: "bob", index: 7, name: "Bob" },
    ]);
  });

  test("deduplicates repeated mentions, keeping the first position", () => {
    expect(parseMentions("@Bob and @Bob again", candidates)).toEqual([
      { id: "bob", index: 0, name: "Bob" },
    ]);
  });

  test("returns mentions in the order they appear", () => {
    const parsed = parseMentions("@Bob asked @Chief of Staff", candidates);
    expect(parsed.map((mention) => mention.id)).toEqual(["bob", "cos"]);
  });

  test("returns nothing when there are no candidates", () => {
    expect(parseMentions("@Bob", [])).toEqual([]);
  });

  test("ignores a bare @", () => {
    expect(parseMentions("what @ even is this", candidates)).toEqual([]);
  });
});
