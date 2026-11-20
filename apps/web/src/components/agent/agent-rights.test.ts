import { expect, test } from "bun:test";
import { canManageAgentKeys } from "./agent-rights.ts";

const agentOwnedBy = (
  ownerUserId: string | null,
  createdBy = "user_creator"
): { createdBy: string; ownerUserId: string | null } => ({
  createdBy,
  ownerUserId,
});

test("the agent's owner, by ownerUserId, may set its credential", () => {
  expect(
    canManageAgentKeys({
      agent: agentOwnedBy("user_owner"),
      isAdmin: false,
      userId: "user_owner",
    })
  ).toBe(true);
});

test("with no ownerUserId, the creator counts as the owner", () => {
  expect(
    canManageAgentKeys({
      agent: agentOwnedBy(null, "user_creator"),
      isAdmin: false,
      userId: "user_creator",
    })
  ).toBe(true);
});

test("an owner set by ownerUserId replaces the creator as the owner", () => {
  expect(
    canManageAgentKeys({
      agent: agentOwnedBy("user_owner", "user_creator"),
      isAdmin: false,
      userId: "user_creator",
    })
  ).toBe(false);
});

test("an org admin who is not the owner may set the credential", () => {
  expect(
    canManageAgentKeys({
      agent: agentOwnedBy("user_owner"),
      isAdmin: true,
      userId: "user_admin",
    })
  ).toBe(true);
});

test("a plain member who is neither owner nor admin may not set the credential", () => {
  expect(
    canManageAgentKeys({
      agent: agentOwnedBy("user_owner"),
      isAdmin: false,
      userId: "user_member",
    })
  ).toBe(false);
});

test("a missing or empty user id may not set the credential unless admin", () => {
  const agent = agentOwnedBy(null, "user_creator");
  expect(canManageAgentKeys({ agent, isAdmin: false, userId: undefined })).toBe(
    false
  );
  expect(canManageAgentKeys({ agent, isAdmin: false, userId: null })).toBe(
    false
  );
  expect(canManageAgentKeys({ agent, isAdmin: false, userId: "" })).toBe(false);
  expect(canManageAgentKeys({ agent, isAdmin: true, userId: undefined })).toBe(
    true
  );
});
