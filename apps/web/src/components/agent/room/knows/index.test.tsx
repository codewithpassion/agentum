import { expect, mock, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";

// The Knows tab reads Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:member", userId: "user_1" }),
}));

const { KnowsTab } = await import("./index.tsx");

test("Knows shows the instructions, voice and skills", () => {
  const html = renderInRoom(<KnowsTab {...fixtureTabProps()} />);
  expect(html).toContain("Instructions");
  expect(html).toContain("Voice");
  expect(html).toContain("Skills");
  expect(html).toContain("Sort the inbox every morning.");
});

test("Knows says it is loading until the memory arrives", () => {
  const html = renderInRoom(<KnowsTab {...fixtureTabProps()} />);
  expect(html).toContain("What Sorter remembers");
  expect(html).toContain("Loading what it knows.");
});
