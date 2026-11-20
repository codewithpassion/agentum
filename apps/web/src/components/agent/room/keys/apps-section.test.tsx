import { beforeEach, expect, mock, test } from "bun:test";
import { fixtureKeys, fixtureRoom, renderInRoom } from "../test-fixtures.tsx";

interface SignedIn {
  orgRole: string;
  userId: string;
}

const admin: SignedIn = { orgRole: "org:admin", userId: "user_1" };
// Read at each render, so a test sets who is signed in before it renders.
let current: SignedIn = admin;

// The section reads Clerk's auth state to tell an admin from a member.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => current,
}));

beforeEach(() => {
  current = admin;
});

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

/** Every opening `<button>` tag whose label is `label`. */
const buttonTags = (html: string, label: string): string[] =>
  [...html.matchAll(new RegExp(`<button[^>]*>${label}</button>`, "g"))].map(
    (match) => match[0]
  );

/** Every opening `<select>` tag labelled `label`. */
const selectTags = (html: string, label: string): string[] =>
  [
    ...html.matchAll(
      new RegExp(`<select[^>]*aria-label="${label}"[^>]*>`, "g")
    ),
  ].map((match) => match[0]);

const DISABLED_ATTR = /\sdisabled=""/;
/** A disabled control has the attribute; Tailwind's `disabled:` classes do not count. */
const isDisabled = (tag: string): boolean => DISABLED_ATTR.test(tag);

const CONTROL_LABELS = {
  mode: "Whose sign-in it uses",
  remove: "Remove",
  tools: "Allowed tools",
};

test("a member who is neither owner nor admin cannot change the apps", () => {
  current = { orgRole: "org:member", userId: "user_2" };
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={fixtureKeys().apps} />
  );
  const tools = buttonTags(html, CONTROL_LABELS.tools);
  const remove = buttonTags(html, CONTROL_LABELS.remove);
  const modes = selectTags(html, CONTROL_LABELS.mode);
  expect(tools).toHaveLength(2);
  expect(remove).toHaveLength(2);
  expect(modes).toHaveLength(2);
  for (const tag of [...tools, ...remove, ...modes]) {
    expect(isDisabled(tag)).toBe(true);
  }
});

test("the agent's owner, as a member, can change the apps", () => {
  current = { orgRole: "org:member", userId: "user_1" };
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={fixtureKeys().apps} />
  );
  for (const tag of [
    ...buttonTags(html, CONTROL_LABELS.tools),
    ...buttonTags(html, CONTROL_LABELS.remove),
    ...selectTags(html, CONTROL_LABELS.mode),
  ]) {
    expect(isDisabled(tag)).toBe(false);
  }
});

test("an admin who owns nothing on the agent can change the apps", () => {
  current = { orgRole: "org:admin", userId: "user_2" };
  const html = renderInRoom(
    <AppsSection agent={fixtureRoom().agent} apps={fixtureKeys().apps} />
  );
  for (const tag of [
    ...buttonTags(html, CONTROL_LABELS.tools),
    ...buttonTags(html, CONTROL_LABELS.remove),
    ...selectTags(html, CONTROL_LABELS.mode),
  ]) {
    expect(isDisabled(tag)).toBe(false);
  }
});
