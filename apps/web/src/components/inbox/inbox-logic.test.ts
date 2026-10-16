import { expect, test } from "bun:test";
import { agentNameMap, authorLabel, canSend } from "./inbox-logic.ts";

const names = agentNameMap([{ id: "agt_1", name: "Researcher" }]);

test("an agent post shows the agent's name, or Agent when the name is unknown", () => {
  expect(
    authorLabel({ authorId: "agt_1", authorKind: "agent" }, "usr_me", names)
  ).toBe("Researcher");
  expect(
    authorLabel({ authorId: "agt_gone", authorKind: "agent" }, "usr_me", names)
  ).toBe("Agent");
});

test("a user post is You for the signed-in user and Teammate for anyone else", () => {
  expect(
    authorLabel({ authorId: "usr_me", authorKind: "user" }, "usr_me", names)
  ).toBe("You");
  expect(
    authorLabel({ authorId: "usr_other", authorKind: "user" }, "usr_me", names)
  ).toBe("Teammate");
});

test("a user post never takes an agent's name, even when ids match", () => {
  expect(
    authorLabel({ authorId: "agt_1", authorKind: "user" }, "usr_me", names)
  ).toBe("Teammate");
});

test("send is allowed only for non-blank text while not already sending", () => {
  expect(canSend("hello", false)).toBe(true);
  expect(canSend("   \n\t", false)).toBe(false);
  expect(canSend("", false)).toBe(false);
  expect(canSend("hello", true)).toBe(false);
});
