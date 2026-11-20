import { expect, test } from "bun:test";
import { canCreateTopic, newTopicInput } from "./new-topic-logic.ts";
import type { RoomMember } from "./room-types.ts";

const ruby: RoomMember = {
  avatar: { color: "blue", glyph: "R" },
  handle: "ruby",
  id: "same_id",
  kind: "agent",
  name: "Ruby",
};
const pat: RoomMember = {
  avatar: null,
  handle: "pat",
  id: "same_id",
  kind: "user",
  name: "Pat",
};
const sam: RoomMember = {
  avatar: null,
  handle: null,
  id: "user_sam",
  kind: "user",
  name: "Sam",
};
const members = [ruby, pat, sam];

test("the title is trimmed and the team id is kept", () => {
  const payload = newTopicInput({
    members,
    selected: new Set(),
    teamId: "team_1",
    title: "  Q3 plans  ",
  });
  expect(payload).toEqual({ teamId: "team_1", title: "Q3 plans" });
});

test("no ticked members leaves out the members key", () => {
  const payload = newTopicInput({
    members,
    selected: new Set(),
    teamId: "team_1",
    title: "Open",
  });
  expect("members" in payload).toBe(false);
});

test("ticked members come back as id and kind, in member order", () => {
  const payload = newTopicInput({
    members,
    selected: new Set(["user:user_sam", "agent:same_id"]),
    teamId: "team_1",
    title: "Limited",
  });
  expect(payload.members).toEqual([
    { id: "same_id", kind: "agent" },
    { id: "user_sam", kind: "user" },
  ]);
});

test("an agent and a person with the same id are told apart by kind", () => {
  const payload = newTopicInput({
    members,
    selected: new Set(["user:same_id"]),
    teamId: "team_1",
    title: "Person only",
  });
  expect(payload.members).toEqual([{ id: "same_id", kind: "user" }]);
});

test("a selected key with no matching member adds nothing", () => {
  const payload = newTopicInput({
    members,
    selected: new Set(["agent:gone"]),
    teamId: "team_1",
    title: "Stale",
  });
  expect(payload.members).toEqual([]);
});

test("a title with text can be created", () => {
  expect(canCreateTopic("Plans", false)).toBe(true);
});

test("a blank or spaces-only title cannot be created", () => {
  expect(canCreateTopic("", false)).toBe(false);
  expect(canCreateTopic("   ", false)).toBe(false);
});

test("a topic that is being created cannot be created again", () => {
  expect(canCreateTopic("Plans", true)).toBe(false);
});
