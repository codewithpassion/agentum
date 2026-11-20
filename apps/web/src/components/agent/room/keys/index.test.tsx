import { expect, mock, test } from "bun:test";
import {
  fixtureRoom,
  fixtureTabProps,
  renderInRoom,
} from "../test-fixtures.tsx";

// The panels read Clerk's auth state, which needs a provider. Each test sets who is signed in.
let signedIn = { orgRole: "org:admin", userId: "user_1" };
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => signedIn,
}));

const { KeysTab } = await import("./index.tsx");

test("Keys shows its five sections", () => {
  signedIn = { orgRole: "org:admin", userId: "user_1" };
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} />);
  for (const title of [
    "Apps it can use",
    "Its own identity",
    "Passwords and keys",
    "Other agents",
    "Ask me before it",
  ]) {
    expect(html).toContain(title);
  }
});

test("the agent's owner, not an admin, sees the passwords and keys and the Slack setup", () => {
  signedIn = { orgRole: "org:member", userId: "user_1" };
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} />);
  expect(html).toContain("Passwords and keys");
  expect(html).toContain("Connect Slack");
});

test("a plain member sees no passwords and keys and no Slack setup", () => {
  signedIn = { orgRole: "org:member", userId: "user_other" };
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} />);
  expect(html).not.toContain("Passwords and keys");
  expect(html).not.toContain("Granted:");
  expect(html).not.toContain("Connect Slack");
  expect(html).toContain(
    "Only the agent&#x27;s owners and admins can set up its Slack app."
  );
  for (const title of ["Apps it can use", "Its own identity", "Other agents"]) {
    expect(html).toContain(title);
  }
});

test("an archived agent shows one note and the asks, not the sections", () => {
  const room = fixtureRoom();
  room.agent = { ...room.agent, status: "archived" };
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} room={room} />);
  expect(html).toContain("This agent is archived.");
  expect(html).toContain("Ask me before it");
  expect(html).not.toContain("Apps it can use");
});

test("when the keys could not load, Keys says so and keeps the unrelated controls", () => {
  signedIn = { orgRole: "org:admin", userId: "user_1" };
  const html = renderInRoom(
    <KeysTab {...fixtureTabProps()} room={{ ...fixtureRoom(), keys: null }} />
  );
  expect(html).toContain("Keys could not be loaded");
  expect(html).toContain("Ask me before it");
  // The controls that do not need the read model stay.
  expect(html).toContain("Passwords and keys");
  expect(html).toContain("Other agents");
  expect(html).not.toContain("Granted:");
});
