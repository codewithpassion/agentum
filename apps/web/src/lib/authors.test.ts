import { describe, expect, test } from "bun:test";
import type { MessageView } from "./api";
import { authorOf, groupKeyOf, memberLabel } from "./authors";

const message = (over: Partial<MessageView>): MessageView => ({
  attachments: [],
  author: null,
  authorId: "",
  authorType: "user",
  body: "hi",
  channelId: "chan_1",
  createdAt: 0,
  id: "msg_1",
  mentions: [],
  origin: "web",
  question: null,
  replyCount: 0,
  threadParentId: null,
  ...over,
});

const person = (memberId: string, id: string): MessageView =>
  message({
    author: { email: null, imageUrl: null, memberId, name: "Ada" },
    authorId: memberId,
    id,
  });

describe("groupKeyOf", () => {
  test("groups a person's messages by their member id", () => {
    expect(groupKeyOf(person("mem_1", "msg_1"))).toBe(
      groupKeyOf(person("mem_1", "msg_2"))
    );
  });

  test("keeps two people apart", () => {
    expect(groupKeyOf(person("mem_1", "msg_1"))).not.toBe(
      groupKeyOf(person("mem_2", "msg_2"))
    );
  });

  test("never groups former members with each other", () => {
    const gone = (id: string) =>
      message({
        author: {
          email: null,
          imageUrl: null,
          memberId: null,
          name: "Former member",
        },
        id,
      });
    expect(groupKeyOf(gone("msg_1"))).not.toBe(groupKeyOf(gone("msg_2")));
  });

  test("agents still group by their agent id", () => {
    const agent = (id: string) =>
      message({ authorId: "agt_1", authorType: "agent", id });
    expect(groupKeyOf(agent("msg_1"))).toBe(groupKeyOf(agent("msg_2")));
  });

  test("an agent and a member with the same id are different speakers", () => {
    expect(
      groupKeyOf(message({ authorId: "x", authorType: "agent" }))
    ).not.toBe(groupKeyOf(person("x", "msg_9")));
  });
});

describe("authorOf, for an external author", () => {
  const viewer = { imageUrl: null, memberId: "mem_1", name: "You" };
  const external = (authorId: string) =>
    authorOf(message({ authorId, authorType: "external" }), new Map(), viewer);

  test("names a routine's firing rather than showing its row id", () => {
    expect(external("routine:rt_123").name).toBe("Routine");
  });

  test("leaves a bridged handle alone", () => {
    expect(external("slack:U123").name).toBe("slack:U123");
  });
});

describe("memberLabel", () => {
  test("prefers the name", () => {
    expect(memberLabel({ email: "ada@example.com", name: "Ada" })).toBe("Ada");
  });

  test("falls back to the email when there is no name", () => {
    expect(memberLabel({ email: "ada@example.com", name: null })).toBe(
      "ada@example.com"
    );
  });

  test("never renders an empty snapshot as an empty string", () => {
    expect(memberLabel({ email: "", name: null })).toBe("Member");
    expect(memberLabel({ email: "  ", name: "  " })).toBe("Member");
  });
});
