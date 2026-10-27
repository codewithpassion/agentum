import { describe, expect, test } from "bun:test";
import {
  type ArtifactPolicyRecord,
  agentCanSee,
  agentCanUpdate,
  canCreateLiveLink,
  canManage,
  canOpen,
  defaultAudience,
  type PolicyUser,
} from "./policy.ts";

const owner: PolicyUser = { isAdmin: false, userId: "user_owner" };
const admin: PolicyUser = { isAdmin: true, userId: "user_admin" };
const member: PolicyUser = { isAdmin: false, userId: "user_member" };

const artifact = (
  overrides: Partial<ArtifactPolicyRecord> = {}
): ArtifactPolicyRecord => ({
  agentId: "agent_maker",
  audience: "private",
  handedToAgentId: null,
  ownerUserId: "user_owner",
  ...overrides,
});

describe("defaultAudience", () => {
  test.each([
    ["null session (a person outside a session)", null, "private"],
    ["ui origin", { origin: "ui", private: false }, "private"],
    ["ui origin and private", { origin: "ui", private: true }, "private"],
    [
      "private session from another origin",
      { origin: "slack", private: true },
      "private",
    ],
    [
      "shared session from another origin",
      { origin: "slack", private: false },
      "workspace",
    ],
    [
      "shared routine session",
      { origin: "routine", private: false },
      "workspace",
    ],
  ] as const)("%s", (_label, session, expected) => {
    expect(defaultAudience(session)).toBe(expected);
  });
});

describe("canOpen", () => {
  test.each([
    [
      "workspace artifact, owner",
      artifact({ audience: "workspace" }),
      owner,
      true,
    ],
    [
      "workspace artifact, member who is neither owner nor admin",
      artifact({ audience: "workspace" }),
      member,
      true,
    ],
    [
      "workspace artifact with no owner, member",
      artifact({ audience: "workspace", ownerUserId: null }),
      member,
      true,
    ],
    ["private artifact, owner", artifact(), owner, true],
    ["private artifact, admin who is not the owner", artifact(), admin, true],
    ["private artifact, member who is neither", artifact(), member, false],
    [
      "private artifact with no owner, member",
      artifact({ ownerUserId: null }),
      member,
      false,
    ],
    [
      "private artifact with no owner, admin",
      artifact({ ownerUserId: null }),
      admin,
      true,
    ],
  ] as const)("%s", (_label, record, user, expected) => {
    expect(canOpen(record, user)).toBe(expected);
  });
});

describe("canManage", () => {
  test.each([
    ["owner", artifact(), owner, true],
    ["admin who is not the owner", artifact(), admin, true],
    ["member who is neither", artifact(), member, false],
    [
      "owned by a member, workspace audience, member who is neither",
      artifact({ audience: "workspace" }),
      member,
      false,
    ],
    [
      "no owner (routine-made), member",
      artifact({ ownerUserId: null }),
      member,
      false,
    ],
    [
      "no owner (routine-made), admin",
      artifact({ ownerUserId: null }),
      admin,
      true,
    ],
  ] as const)("%s", (_label, record, user, expected) => {
    expect(canManage(record, user)).toBe(expected);
  });
});

describe("canCreateLiveLink", () => {
  test.each([
    ["owner", artifact(), owner, true],
    ["admin who is not the owner", artifact(), admin, false],
    ["member who is neither", artifact(), member, false],
    ["no owner, admin", artifact({ ownerUserId: null }), admin, false],
    ["no owner, member", artifact({ ownerUserId: null }), member, false],
    [
      "owner of a workspace artifact",
      artifact({ audience: "workspace" }),
      owner,
      true,
    ],
  ] as const)("%s", (_label, record, user, expected) => {
    expect(canCreateLiveLink(record, user)).toBe(expected);
  });
});

describe("agentCanSee", () => {
  test.each([
    [
      "workspace artifact, stranger agent",
      artifact({ audience: "workspace" }),
      "agent_stranger",
      true,
    ],
    [
      "workspace artifact, null agent",
      artifact({ audience: "workspace" }),
      null,
      true,
    ],
    [
      "private artifact, the agent that made it",
      artifact(),
      "agent_maker",
      true,
    ],
    [
      "private artifact, the handed-to agent",
      artifact({ handedToAgentId: "agent_next" }),
      "agent_next",
      true,
    ],
    ["private artifact, stranger agent", artifact(), "agent_stranger", false],
    ["private artifact, null agent", artifact(), null, false],
    [
      "private artifact with null agentId and null handedToAgentId, null agent",
      artifact({ agentId: null }),
      null,
      false,
    ],
    [
      "private artifact with null agentId, any agent",
      artifact({ agentId: null }),
      "agent_stranger",
      false,
    ],
  ] as const)("%s", (_label, record, agentId, expected) => {
    expect(agentCanSee(record, agentId)).toBe(expected);
  });
});

describe("agentCanUpdate", () => {
  test.each([
    ["the agent that made it", artifact(), "agent_maker", true],
    [
      "the handed-to agent",
      artifact({ handedToAgentId: "agent_next" }),
      "agent_next",
      true,
    ],
    ["a stranger agent", artifact(), "agent_stranger", false],
    [
      "a workspace artifact, a stranger agent",
      artifact({ audience: "workspace" }),
      "agent_stranger",
      false,
    ],
    ["a null agent", artifact(), null, false],
    ["a null agentId and null agent", artifact({ agentId: null }), null, false],
    [
      "a null handedToAgentId and null agent",
      artifact({ handedToAgentId: null }),
      null,
      false,
    ],
    [
      "a null agentId, handed-to agent",
      artifact({ agentId: null, handedToAgentId: "agent_next" }),
      "agent_next",
      true,
    ],
  ] as const)("%s", (_label, record, agentId, expected) => {
    expect(agentCanUpdate(record, agentId)).toBe(expected);
  });
});
