import { expect, test } from "bun:test";
import {
  applyMention,
  matchMentionCandidates,
  mentionQueryAt,
} from "./mention-input";

test("finds the mention query at the caret", () => {
  const text = "hello @chief";
  expect(mentionQueryAt(text, text.length)).toEqual({
    query: "chief",
    start: 6,
  });
});

test("spans spaces, because agent names contain them", () => {
  const text = "hi @Chief of";
  expect(mentionQueryAt(text, text.length)?.query).toBe("Chief of");
});

test("ignores an @ glued to a word, such as an email address", () => {
  const text = "mail me at bob@example";
  expect(mentionQueryAt(text, text.length)).toBeUndefined();
});

test("replaces the query with the full name and a trailing space", () => {
  const text = "hi @chi rest";
  const caret = 7;
  const mention = mentionQueryAt(text, caret);
  if (!mention) {
    throw new Error("expected a mention query");
  }
  expect(applyMention(text, mention, caret, "Chief of Staff")).toEqual({
    caret: 19,
    text: "hi @Chief of Staff  rest",
  });
});

test("matches candidates case-insensitively on a substring", () => {
  const candidates = [{ name: "Chief of Staff" }, { name: "Researcher" }];
  expect(matchMentionCandidates(candidates, "STAFF")).toEqual([
    { name: "Chief of Staff" },
  ]);
  expect(matchMentionCandidates(candidates, "")).toHaveLength(2);
});
