import { expect, test } from "bun:test";
import {
  canCreateWorkspace,
  switchErrorMessage,
  workspaceChoices,
} from "./workspace-menu-logic.ts";

const mine = [
  { clerkOrgId: "org_b", role: "org:member", workspaceId: "ws_b" },
  { clerkOrgId: "org_a", role: "org:admin", workspaceId: "ws_a" },
];

test("one choice per server workspace, named from Clerk", () => {
  const choices = workspaceChoices({
    activeOrgId: "org_a",
    mine,
    orgs: [
      { id: "org_a", name: "Alpha" },
      { id: "org_b", name: "Beta" },
    ],
  });
  expect(choices).toEqual([
    { current: true, id: "org_a", name: "Alpha" },
    { current: false, id: "org_b", name: "Beta" },
  ]);
});

test("an org Clerk lists but the server does not is dropped", () => {
  const choices = workspaceChoices({
    activeOrgId: null,
    mine,
    orgs: [
      { id: "org_a", name: "Alpha" },
      { id: "org_b", name: "Beta" },
      { id: "org_c", name: "Gamma" },
    ],
  });
  expect(choices.map((choice) => choice.id)).toEqual(["org_a", "org_b"]);
});

test("a renamed org shows its name from Clerk", () => {
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: [{ clerkOrgId: "org_a", role: "org:member", workspaceId: "ws_a" }],
    orgs: [{ id: "org_a", name: "New Name" }],
  });
  expect(choices[0]?.name).toBe("New Name");
});

test("an org missing from Clerk's list uses its id as the name", () => {
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: [{ clerkOrgId: "org_z", role: "org:member", workspaceId: "ws_z" }],
    orgs: [],
  });
  expect(choices).toEqual([{ current: false, id: "org_z", name: "org_z" }]);
});

test("a blank Clerk name falls back to the id", () => {
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: [{ clerkOrgId: "org_z", role: "org:member", workspaceId: "ws_z" }],
    orgs: [{ id: "org_z", name: "   " }],
  });
  expect(choices[0]?.name).toBe("org_z");
});

test("the active org is first, then the others by name, ignoring case", () => {
  const choices = workspaceChoices({
    activeOrgId: "org_1",
    mine: [
      { clerkOrgId: "org_1", role: "org:member", workspaceId: "ws_1" },
      { clerkOrgId: "org_2", role: "org:member", workspaceId: "ws_2" },
      { clerkOrgId: "org_3", role: "org:member", workspaceId: "ws_3" },
    ],
    orgs: [
      { id: "org_1", name: "zeta" },
      { id: "org_2", name: "Alpha" },
      { id: "org_3", name: "beta" },
    ],
  });
  expect(choices.map((choice) => choice.name)).toEqual([
    "zeta",
    "Alpha",
    "beta",
  ]);
});

test("names that match ignoring case are ordered by id", () => {
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: [
      { clerkOrgId: "org_b", role: "org:member", workspaceId: "ws_b" },
      { clerkOrgId: "org_a", role: "org:member", workspaceId: "ws_a" },
    ],
    orgs: [
      { id: "org_a", name: "same" },
      { id: "org_b", name: "SAME" },
    ],
  });
  expect(choices.map((choice) => choice.id)).toEqual(["org_a", "org_b"]);
});

test("no active org marks no choice as current", () => {
  const choices = workspaceChoices({ activeOrgId: null, mine, orgs: [] });
  expect(choices.some((choice) => choice.current)).toBe(false);
});

test("a long name is kept in full", () => {
  const name =
    "A very long organisation name that goes on and on past any menu width";
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: [{ clerkOrgId: "org_a", role: "org:member", workspaceId: "ws_a" }],
    orgs: [{ id: "org_a", name }],
  });
  expect(choices[0]?.name).toBe(name);
});

test("only an org admin of the active workspace can create one", () => {
  expect(canCreateWorkspace({ activeOrgId: "org_a", mine })).toBe(true);
  expect(canCreateWorkspace({ activeOrgId: "org_b", mine })).toBe(false);
});

test("a workspace the person is not in cannot be created from", () => {
  expect(canCreateWorkspace({ activeOrgId: "org_x", mine })).toBe(false);
  expect(canCreateWorkspace({ activeOrgId: null, mine })).toBe(false);
});

test("an org:member-like role is not admin", () => {
  const roles = [
    { clerkOrgId: "org_a", role: "admin", workspaceId: "ws_a" },
    { clerkOrgId: "org_a", role: "org:admin ", workspaceId: "ws_a" },
  ];
  expect(canCreateWorkspace({ activeOrgId: "org_a", mine: roles })).toBe(false);
});

test("an Error gives its message", () => {
  expect(switchErrorMessage(new Error("Org not allowed"))).toBe(
    "Org not allowed"
  );
});

test("a string error is used as is", () => {
  expect(switchErrorMessage("Session expired")).toBe("Session expired");
});

test("surrounding whitespace is trimmed", () => {
  expect(switchErrorMessage(new Error("  Padded  "))).toBe("Padded");
  expect(switchErrorMessage("  Padded  ")).toBe("Padded");
});

test("an empty message falls back to the default", () => {
  const noText = "";
  expect(switchErrorMessage(new Error(noText))).toBe(
    "Could not switch workspace."
  );
  expect(switchErrorMessage("   ")).toBe("Could not switch workspace.");
});

test("any other value gives the default", () => {
  expect(switchErrorMessage(undefined)).toBe("Could not switch workspace.");
  expect(switchErrorMessage({ message: "nope" })).toBe(
    "Could not switch workspace."
  );
});
