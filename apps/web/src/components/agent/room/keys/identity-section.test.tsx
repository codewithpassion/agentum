import { expect, test } from "bun:test";
import { fixtureKeys, fixtureRoom, renderInRoom } from "../test-fixtures.tsx";

const { IdentitySection } = await import("./identity-section.tsx");

test("identity section shows the email address and the Slack app state", () => {
  const html = renderInRoom(
    <IdentitySection
      agent={fixtureRoom().agent}
      canManage
      identity={fixtureKeys().identity}
      provisionLabel={null}
    />
  );
  for (const text of [
    "Its own identity",
    "sorter@example.com",
    "Slack app installed.",
    "Connect Slack",
  ]) {
    expect(html).toContain(text);
  }
});

test("identity section offers mail setup when there is no address yet", () => {
  const html = renderInRoom(
    <IdentitySection
      agent={fixtureRoom().agent}
      canManage
      identity={{ emailAddress: null, slackApp: null }}
      provisionLabel="Set up mail"
    />
  );
  for (const text of [
    "No email address yet.",
    "No Slack app yet.",
    "Set up mail",
  ]) {
    expect(html).toContain(text);
  }
});

test("identity section keeps the Slack setup from someone who cannot manage the agent", () => {
  const html = renderInRoom(
    <IdentitySection
      agent={fixtureRoom().agent}
      canManage={false}
      identity={fixtureKeys().identity}
      provisionLabel={null}
    />
  );
  expect(html).toContain("Slack app installed.");
  expect(html).toContain(
    "Only the agent&#x27;s owners and admins can set up its Slack app."
  );
  expect(html).not.toContain("Connect Slack");
});
