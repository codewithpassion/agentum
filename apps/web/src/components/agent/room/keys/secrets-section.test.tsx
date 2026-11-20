import { expect, mock, test } from "bun:test";
import { fixtureKeys, fixtureRoom, renderInRoom } from "../test-fixtures.tsx";

// The secrets panel reads Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { SecretsSection } = await import("./secrets-section.tsx");

test("Passwords and keys names each granted secret and how it is used", () => {
  const html = renderInRoom(
    <SecretsSection
      agent={fixtureRoom().agent}
      secrets={fixtureKeys().secrets}
    />
  );
  expect(html).toContain("Passwords and keys");
  expect(html).toContain("Stripe key");
  expect(html).toContain("Granted: Stripe key (added to its requests)");
});

test("Passwords and keys says when no secret is granted", () => {
  const html = renderInRoom(
    <SecretsSection agent={fixtureRoom().agent} secrets={[]} />
  );
  expect(html).toContain("No secrets are granted to this agent yet.");
});
