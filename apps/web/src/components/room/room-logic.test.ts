import { expect, test } from "bun:test";
import type { AgentAvatar, Team } from "@repo/db/shared";
import type { InboxThread } from "#/integrations/trpc/types.ts";
import {
  assignedTo,
  authorName,
  canPostInRoom,
  isEveryone,
  memberOfPost,
  requestsOfTopic,
  roomDirectory,
  roomMembers,
  topicSessionIds,
  topicsOfTeam,
} from "./room-logic.ts";
import { memberKey, type RoomMember } from "./room-types.ts";

const avatar: AgentAvatar = { color: "blue", glyph: "R" };
const createdAt = "2026-01-01T00:00:00.000Z";

const thread = (overrides: Partial<InboxThread>): InboxThread => ({
  attentionClearedAt: null,
  createdAt,
  createdBy: "u1",
  id: "t1",
  lastPostAt: createdAt,
  teamId: "team1",
  title: "T",
  ...overrides,
});

const ruby: RoomMember = {
  avatar,
  handle: "ruby",
  id: "agent_ruby",
  kind: "agent",
  name: "Ruby",
};
const amir: RoomMember = {
  avatar: null,
  handle: "amir",
  id: "u_amir",
  kind: "user",
  name: "Amir",
};
const zoe: RoomMember = {
  avatar: null,
  handle: null,
  id: "u_zoe",
  kind: "user",
  name: "Zoe",
};

const directory = roomDirectory({
  agents: [
    { avatar, id: "agent_ruby", name: "Ruby", slug: "ruby" },
    {
      avatar: { color: "orange", glyph: "A" },
      id: "agent_arlo",
      name: "Arlo",
      slug: "arlo",
    },
  ],
  handles: new Map([["u_amir", "amir"]]),
  people: [
    { name: "Zoe", userId: "u_zoe" },
    { name: "Amir", userId: "u_amir" },
  ],
});

const everyoneTeam: Pick<Team, "members" | "slug"> = {
  members: [],
  slug: "everyone",
};

const ownTeam: Pick<Team, "members" | "slug"> = {
  members: [
    {
      isHome: true,
      memberId: "agent_ruby",
      memberKind: "agent",
      teamId: "team1",
    },
    { isHome: false, memberId: "u_amir", memberKind: "user", teamId: "team1" },
  ],
  slug: "finance",
};

test("isEveryone is true only for the Everyone team slug", () => {
  expect(isEveryone({ slug: "everyone" })).toBe(true);
  expect(isEveryone({ slug: "finance" })).toBe(false);
});

test("topicsOfTeam keeps threads of the team in input order", () => {
  const threads = [
    thread({ id: "a", teamId: "team1" }),
    thread({ id: "b", teamId: "team2" }),
    thread({ id: "c", teamId: "team1" }),
  ];
  const topics = topicsOfTeam(threads, { id: "team1", slug: "finance" });
  expect(topics.map((topic) => topic.id)).toEqual(["a", "c"]);
});

test("topicsOfTeam adds legacy null-team topics only to Everyone", () => {
  const threads = [
    thread({ id: "legacy", teamId: null }),
    thread({ id: "mine", teamId: "team1" }),
    thread({ id: "other", teamId: "team2" }),
  ];
  const inEveryone = topicsOfTeam(threads, {
    id: "everyone1",
    slug: "everyone",
  });
  const inFinance = topicsOfTeam(threads, { id: "team1", slug: "finance" });
  expect(inEveryone.map((topic) => topic.id)).toEqual(["legacy"]);
  expect(inFinance.map((topic) => topic.id)).toEqual(["mine"]);
});

test("canPostInRoom lets anyone post in Everyone", () => {
  expect(canPostInRoom(everyoneTeam, "u_stranger")).toBe(true);
});

test("canPostInRoom allows a team's person and refuses a non-member", () => {
  expect(canPostInRoom(ownTeam, "u_amir")).toBe(true);
  expect(canPostInRoom(ownTeam, "u_zoe")).toBe(false);
});

test("canPostInRoom ignores an agent row that shares the user id", () => {
  const team: Pick<Team, "members" | "slug"> = {
    members: [
      { isHome: true, memberId: "u_zoe", memberKind: "agent", teamId: "team1" },
    ],
    slug: "finance",
  };
  expect(canPostInRoom(team, "u_zoe")).toBe(false);
});

test("roomDirectory keys agents and people and gives people a handle when known", () => {
  expect(directory.get(memberKey("agent", "agent_ruby"))).toEqual(ruby);
  expect(directory.get(memberKey("user", "u_amir"))).toEqual(amir);
  expect(directory.get(memberKey("user", "u_zoe"))).toEqual(zoe);
  expect(directory.size).toBe(4);
});

test("roomDirectory keeps an agent and a person with the same id apart", () => {
  const same = roomDirectory({
    agents: [{ avatar, id: "x1", name: "Bot", slug: "bot" }],
    handles: new Map(),
    people: [{ name: "Xi", userId: "x1" }],
  });
  expect(same.get(memberKey("agent", "x1"))?.name).toBe("Bot");
  expect(same.get(memberKey("user", "x1"))?.name).toBe("Xi");
});

test("roomMembers for Everyone returns the whole directory, agents first", () => {
  const members = roomMembers({ directory, team: everyoneTeam });
  expect(members.map((member) => member.name)).toEqual([
    "Arlo",
    "Ruby",
    "Amir",
    "Zoe",
  ]);
});

test("roomMembers for a team returns its named members in sorted order", () => {
  const members = roomMembers({ directory, team: ownTeam });
  expect(members).toEqual([ruby, amir]);
});

test("roomMembers skips an archived agent row the directory does not know", () => {
  const team: Pick<Team, "members" | "slug"> = {
    members: [
      {
        isHome: false,
        memberId: "agent_gone",
        memberKind: "agent",
        teamId: "team1",
      },
      {
        isHome: true,
        memberId: "agent_ruby",
        memberKind: "agent",
        teamId: "team1",
      },
    ],
    slug: "finance",
  };
  expect(roomMembers({ directory, team })).toEqual([ruby]);
});

test("roomMembers adds an unknown team person as a Teammate", () => {
  const team: Pick<Team, "members" | "slug"> = {
    members: [
      {
        isHome: false,
        memberId: "u_ghost",
        memberKind: "user",
        teamId: "team1",
      },
    ],
    slug: "finance",
  };
  expect(roomMembers({ directory, team })).toEqual([
    {
      avatar: null,
      handle: null,
      id: "u_ghost",
      kind: "user",
      name: "Teammate",
    },
  ]);
});

test("roomMembers lists a member once even when a row repeats", () => {
  const team: Pick<Team, "members" | "slug"> = {
    members: [
      {
        isHome: true,
        memberId: "agent_ruby",
        memberKind: "agent",
        teamId: "team1",
      },
      {
        isHome: false,
        memberId: "agent_ruby",
        memberKind: "agent",
        teamId: "team2",
      },
      {
        isHome: false,
        memberId: "u_ghost",
        memberKind: "user",
        teamId: "team1",
      },
      {
        isHome: false,
        memberId: "u_ghost",
        memberKind: "user",
        teamId: "team2",
      },
    ],
    slug: "finance",
  };
  const members = roomMembers({ directory, team });
  expect(members.map((member) => member.id)).toEqual(["agent_ruby", "u_ghost"]);
});

test("memberOfPost returns the directory entry for a known author", () => {
  const post = { authorId: "u_amir", authorKind: "user" as const };
  expect(memberOfPost(post, directory)).toEqual(amir);
});

test("memberOfPost falls back to Agent for an unknown agent author", () => {
  const post = { authorId: "agent_gone", authorKind: "agent" as const };
  expect(memberOfPost(post, directory)).toEqual({
    avatar: null,
    handle: null,
    id: "agent_gone",
    kind: "agent",
    name: "Agent",
  });
});

test("memberOfPost falls back to Teammate for an unknown person author", () => {
  const post = { authorId: "u_ghost", authorKind: "user" as const };
  expect(memberOfPost(post, directory)).toEqual({
    avatar: null,
    handle: null,
    id: "u_ghost",
    kind: "user",
    name: "Teammate",
  });
});

test("authorName says You for the viewer and the name for anyone else", () => {
  expect(authorName(amir, "u_amir")).toBe("You");
  expect(authorName(zoe, "u_amir")).toBe("Zoe");
  expect(authorName(ruby, "u_amir")).toBe("Ruby");
});

test("authorName does not say You for an agent that shares the viewer's id", () => {
  const agentWithSameId: RoomMember = { ...ruby, id: "u_amir" };
  expect(authorName(agentWithSameId, "u_amir")).toBe("Ruby");
});

test("assignedTo returns the members a lead agent post mentions", () => {
  const post = {
    authorId: "agent_ruby",
    authorKind: "agent" as const,
    text: "@amir please check, cc @zoe",
  };
  expect(assignedTo(post, "agent_ruby", [ruby, amir, zoe])).toEqual([amir]);
});

test("assignedTo is empty for a post from an agent that is not the lead", () => {
  const post = {
    authorId: "agent_arlo",
    authorKind: "agent" as const,
    text: "@amir over to you",
  };
  expect(assignedTo(post, "agent_ruby", [ruby, amir])).toEqual([]);
});

test("assignedTo is empty for a person's post even when it mentions people", () => {
  const post = {
    authorId: "u_amir",
    authorKind: "user" as const,
    text: "@ruby can you take this",
  };
  expect(assignedTo(post, "u_amir", [ruby, amir])).toEqual([]);
});

test("assignedTo is empty when the team has no lead", () => {
  const post = {
    authorId: "agent_ruby",
    authorKind: "agent" as const,
    text: "@amir hi",
  };
  expect(assignedTo(post, null, [ruby, amir])).toEqual([]);
});

test("assignedTo leaves out the lead when its own post mentions it", () => {
  const post = {
    authorId: "agent_ruby",
    authorKind: "agent" as const,
    text: "@ruby noting this, @amir please act",
  };
  expect(assignedTo(post, "agent_ruby", [ruby, amir])).toEqual([amir]);
});

test("topicSessionIds collects the sessions linked to a thread", () => {
  const sessions = [
    { externalKey: "t1", id: "s1" },
    { externalKey: "t2", id: "s2" },
    { externalKey: null, id: "s3" },
    { externalKey: "t1", id: "s4" },
  ];
  expect(topicSessionIds(sessions, "t1")).toEqual(new Set(["s1", "s4"]));
  expect(topicSessionIds(sessions, "t9")).toEqual(new Set());
});

test("requestsOfTopic keeps the records of the given sessions in order", () => {
  const records = [
    { id: "r1", sessionId: "s2" },
    { id: "r2", sessionId: "s1" },
    { id: "r3", sessionId: "s4" },
    { id: "r4", sessionId: "s1" },
  ];
  const picked = requestsOfTopic(records, new Set(["s1", "s2"]));
  expect(picked.map((record) => record.id)).toEqual(["r1", "r2", "r4"]);
  expect(requestsOfTopic(records, new Set())).toEqual([]);
});
