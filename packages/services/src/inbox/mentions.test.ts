import { expect, test } from "bun:test";
import { MAX_MENTIONS, parseMentions } from "./mentions.ts";

test("returns mentioned slugs in order of first appearance", () => {
  expect(parseMentions("hi @pelican, and @owl-2.")).toEqual([
    "pelican",
    "owl-2",
  ]);
});

test("accepts a mention next to punctuation", () => {
  expect(parseMentions("(@pelican)")).toEqual(["pelican"]);
});

test("drops duplicate slugs and keeps the first position", () => {
  expect(parseMentions("@owl @pelican @owl @pelican")).toEqual([
    "owl",
    "pelican",
  ]);
});

test("lowercases slugs so casing does not make duplicates", () => {
  expect(parseMentions("@Pelican and @PELICAN and @pElIcAn")).toEqual([
    "pelican",
  ]);
});

test("does not match an @ inside an email address", () => {
  expect(parseMentions("write to me@example.com")).toEqual([]);
});

test("does not match an @ after an underscore, digit or @", () => {
  expect(parseMentions("a_@pelican 1@owl @@x")).toEqual([]);
});

test("does not match an @ after a letter with accents", () => {
  expect(parseMentions("café@owl")).toEqual([]);
});

test("leaves a trailing hyphen out of the slug", () => {
  expect(parseMentions("@pelican-")).toEqual(["pelican"]);
});

test("skips a slug that is one character long", () => {
  expect(parseMentions("@a @bb")).toEqual(["bb"]);
});

test("accepts a slug of exactly 2 and 40 characters", () => {
  const forty = `a${"b".repeat(38)}z`;
  expect(parseMentions(`@ab @${forty}`)).toEqual(["ab", forty]);
});

test("skips a slug of 41 characters instead of truncating it", () => {
  const fortyOne = `a${"b".repeat(39)}z`;
  expect(parseMentions(`@${fortyOne} @owl`)).toEqual(["owl"]);
});

test("skips a slug that starts with a hyphen", () => {
  expect(parseMentions("@-pelican")).toEqual([]);
});

test("caps the result at MAX_MENTIONS distinct slugs", () => {
  const text = Array.from(
    { length: MAX_MENTIONS + 5 },
    (_, index) => `@agent${index}`
  ).join(" ");
  const slugs = parseMentions(text);

  expect(MAX_MENTIONS).toBe(10);
  expect(slugs).toHaveLength(MAX_MENTIONS);
  expect(slugs[0]).toBe("agent0");
  expect(slugs[MAX_MENTIONS - 1]).toBe(`agent${MAX_MENTIONS - 1}`);
});

test("duplicates do not use up the cap", () => {
  const text = `${"@owl ".repeat(20)}@pelican`;
  expect(parseMentions(text)).toEqual(["owl", "pelican"]);
});

test("returns an empty list when there are no mentions", () => {
  expect(parseMentions("no mentions here")).toEqual([]);
});
