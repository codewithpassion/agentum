import { expect, test } from "bun:test";
import {
  activeMention,
  insertMention,
  mentionedMembers,
  mentionOptions,
} from "./mention-logic.ts";
import type { RoomMember } from "./room-types.ts";

const member = (
  overrides: Partial<RoomMember> & Pick<RoomMember, "name">
): RoomMember => ({
  avatar: null,
  handle: null,
  id: overrides.name.toLowerCase(),
  kind: "user",
  ...overrides,
});

const ruby = member({ handle: "ruby", kind: "agent", name: "Ruby" });
const amy = member({ handle: "amy", name: "Amy Ng" });
const fakeEcho = member({ handle: "fake-echo", kind: "agent", name: "Echo" });

test("activeMention returns the token for a partly typed handle", () => {
  expect(activeMention("hi @fa", 6)).toEqual({ end: 6, query: "fa", start: 3 });
});

test("activeMention returns an empty query right after the @", () => {
  expect(activeMention("hi @", 4)).toEqual({ end: 4, query: "", start: 3 });
});

test("activeMention returns a token at the start of the text", () => {
  expect(activeMention("@ru", 3)).toEqual({ end: 3, query: "ru", start: 0 });
});

test("activeMention reads only up to the caret", () => {
  expect(activeMention("hi @fable", 5)).toEqual({
    end: 5,
    query: "f",
    start: 3,
  });
});

test("activeMention returns null when the @ is inside an email address", () => {
  expect(activeMention("mail me@x", 9)).toBeNull();
});

test("activeMention returns null when a space sits between the @ and the caret", () => {
  expect(activeMention("@a b", 4)).toBeNull();
});

test("activeMention returns null when the @ follows another @ or an underscore", () => {
  expect(activeMention("@@ru", 4)).toBeNull();
  expect(activeMention("a_@x", 4)).toBeNull();
});

test("activeMention returns null when the @ follows a letter from another script", () => {
  expect(activeMention("é@x", 3)).toBeNull();
});

test("activeMention returns null when the query has a non-ASCII letter", () => {
  expect(activeMention("@café", 5)).toBeNull();
});

test("activeMention accepts digits and hyphens in the query", () => {
  expect(activeMention("@ab-1", 5)).toEqual({
    end: 5,
    query: "ab-1",
    start: 0,
  });
});

test("activeMention uses the last @ before the caret", () => {
  expect(activeMention("@a @b", 5)).toEqual({ end: 5, query: "b", start: 3 });
});

test("activeMention returns null when no @ precedes the caret", () => {
  expect(activeMention("hi there", 8)).toBeNull();
  expect(activeMention("hi @x", 2)).toBeNull();
});

test("mentionOptions drops members without a handle", () => {
  const people = [member({ name: "Dom" }), amy];
  expect(mentionOptions("", people)).toEqual([amy]);
  expect(mentionOptions("dom", people)).toEqual([]);
});

test("mentionOptions with an empty query lists agents first, then by name", () => {
  const dana = member({ handle: "dana", name: "Dana" });
  const agentZed = member({ handle: "zed", kind: "agent", name: "Zed" });
  const agentBo = member({ handle: "bo", kind: "agent", name: "Bo" });
  expect(mentionOptions("", [amy, agentZed, dana, agentBo])).toEqual([
    agentBo,
    agentZed,
    amy,
    dana,
  ]);
});

test("mentionOptions ranks handle prefix, then name word prefix, then substring", () => {
  const handlePrefix = member({ handle: "ruby-ops", name: "Zed" });
  const namePrefix = member({ handle: "zzz", name: "Ops Ruby" });
  const substring = member({ handle: "xruby", name: "Xavier" });
  const noMatch = member({ handle: "nope", name: "Nope" });
  expect(
    mentionOptions("ru", [substring, namePrefix, noMatch, handlePrefix])
  ).toEqual([handlePrefix, namePrefix, substring]);
});

test("mentionOptions sorts within a rank by name, then handle", () => {
  const zedRu = member({ handle: "ru-zed", name: "Zed" });
  const amyRu = member({ handle: "ru-amy", name: "Amy" });
  expect(mentionOptions("ru", [zedRu, amyRu])).toEqual([amyRu, zedRu]);
});

test("mentionOptions matches case-insensitively", () => {
  expect(mentionOptions("RUB", [ruby, amy])).toEqual([ruby]);
  expect(mentionOptions("AMY", [ruby, amy])).toEqual([amy]);
});

test("mentionOptions caps the result at the limit", () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    member({ handle: `ab${n}`, name: `Person ${n}` })
  );
  expect(mentionOptions("ab", many)).toHaveLength(6);
  expect(mentionOptions("ab", many, 2)).toHaveLength(2);
  expect(mentionOptions("", many, 3)).toHaveLength(3);
});

test("mentionOptions does not change the input array", () => {
  const people = [amy, ruby, fakeEcho];
  const before = [...people];
  mentionOptions("", people);
  mentionOptions("e", people);
  expect(people).toEqual(before);
});

test("insertMention replaces the token with the handle and one trailing space", () => {
  const token = { end: 6, query: "fa", start: 3 };
  expect(insertMention("hi @fa", token, "ruby")).toEqual({
    caret: 9,
    text: "hi @ruby ",
  });
});

test("insertMention keeps the text after the token", () => {
  const token = { end: 4, query: "r", start: 2 };
  expect(insertMention("a @r b", token, "ruby")).toEqual({
    caret: 8,
    text: "a @ruby  b",
  });
});

test("mentionedMembers finds a mention at the start of the text", () => {
  expect(mentionedMembers("@ruby hello", [ruby, amy])).toEqual([ruby]);
});

test("mentionedMembers finds a mention inside a sentence", () => {
  expect(mentionedMembers("hey @ruby can you look", [ruby, amy])).toEqual([
    ruby,
  ]);
});

test("mentionedMembers lists a repeated mention once, in order of first appearance", () => {
  const text = "@amy and @ruby, then @ruby again and @amy";
  expect(mentionedMembers(text, [ruby, amy])).toEqual([amy, ruby]);
});

test("mentionedMembers matches handles case-insensitively", () => {
  expect(mentionedMembers("@RUBY", [ruby])).toEqual([ruby]);
});

test("mentionedMembers ignores an @ inside an email address", () => {
  expect(mentionedMembers("write to dom@amy.com", [amy])).toEqual([]);
});

test("mentionedMembers stops a hyphenated handle at a trailing hyphen", () => {
  expect(mentionedMembers("@fake-echo- hi", [fakeEcho])).toEqual([fakeEcho]);
});

test("mentionedMembers never matches a member without a handle", () => {
  const noHandle = member({ name: "Dom" });
  expect(mentionedMembers("@Dom are you there", [noHandle])).toEqual([]);
});
