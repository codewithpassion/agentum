import { expect, mock, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";

// The Subagents switch and the connector panels read Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { KeysTab } = await import("./index.tsx");

test("Keys shows tools, channels, works with and ask before", () => {
  const html = renderInRoom(<KeysTab {...fixtureTabProps()} />);
  for (const title of [
    "Tools",
    "Channels",
    "Works with",
    "Ask me before it",
    "Hands to",
    "Subagents",
    "Peers",
  ]) {
    expect(html).toContain(title);
  }
});
