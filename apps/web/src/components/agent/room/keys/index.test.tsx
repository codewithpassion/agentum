import { expect, mock, test } from "bun:test";
import {
  fixtureRoom,
  fixtureTabProps,
  renderInRoom,
} from "../test-fixtures.tsx";

// The panels read Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { KeysTab } = await import("./index.tsx");

test("Keys shows its five sections", () => {
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

test("an archived agent shows one note and the asks, not the sections", () => {
  const room = fixtureRoom();
  room.agent = { ...room.agent, status: "archived" };
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} room={room} />);
  expect(html).toContain("This agent is archived.");
  expect(html).toContain("Ask me before it");
  expect(html).not.toContain("Apps it can use");
});

test("when the keys could not load, Keys says so and still shows the asks", () => {
  const html = renderInRoom(
    <KeysTab {...fixtureTabProps()} room={{ ...fixtureRoom(), keys: null }} />
  );
  expect(html).toContain("Keys could not be loaded");
  expect(html).toContain("Ask me before it");
});
