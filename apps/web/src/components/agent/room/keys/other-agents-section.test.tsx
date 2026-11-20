import { expect, mock, test } from "bun:test";
import { fixtureKeys, fixtureRoom, renderInRoom } from "../test-fixtures.tsx";

// The Subagents switch and the connections card read Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { OtherAgentsSection } = await import("./other-agents-section.tsx");

test("Other agents shows hands-to and outside connections", () => {
  const room = fixtureRoom();
  const html = renderInRoom(
    <OtherAgentsSection
      agent={room.agent}
      connections={room.connections}
      otherAgents={fixtureKeys().otherAgents}
      published={room.published}
    />
  );
  expect(html).toContain("Other agents");
  expect(html).toContain("Hands work to Scout.");
  expect(html).toContain("Harbour Edge");
});

test("Other agents says when it hands work to no one and is not connected", () => {
  const room = fixtureRoom();
  const html = renderInRoom(
    <OtherAgentsSection
      agent={room.agent}
      connections={room.connections}
      otherAgents={{ connections: [], handsTo: [] }}
      published={room.published}
    />
  );
  expect(html).toContain("Hands work to no one.");
  expect(html).toContain("Not connected to any other agent.");
});
