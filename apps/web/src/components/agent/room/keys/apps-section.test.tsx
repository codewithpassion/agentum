import { expect, mock, test } from "bun:test";
import { fixtureKeys, fixtureRoom, renderInRoom } from "../test-fixtures.tsx";

// The section reads Clerk's auth state to tell an admin from a member.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { AppsSection } = await import("./apps-section.tsx");

test("each app row says whose sign-in it uses, in words", () => {
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={fixtureKeys().apps} />
  );
  expect(html).toContain("Gmail");
  expect(html).toContain("Uses the sign-in of the person asking, or its own.");
  expect(html).toContain("Docs");
  expect(html).toContain("Uses its own sign-in.");
});

test("before the member's own sign-ins load, no row claims a sign-in is missing", () => {
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={fixtureKeys().apps} />
  );
  expect(html).not.toContain("has no sign-in yet");
  expect(html).not.toContain("not signed in");
  expect(html).not.toContain("Connect my account");
});

test("with no apps it says so", () => {
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={[]} />
  );
  expect(html).toContain("No apps yet.");
});
