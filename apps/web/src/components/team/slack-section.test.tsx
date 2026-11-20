import { expect, test } from "bun:test";
import type {
  TeamSlackChannels,
  TeamSlackMemberApp,
  TeamSlackStatus,
} from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { SlackSection, type SlackSectionProps } from "./slack-section.tsx";
import type { TeamAgent } from "./team-logic.ts";

const noop = (): void => undefined;
const noLink = (): void => undefined;

const agents: readonly TeamAgent[] = [
  {
    avatar: { color: "blue", glyph: "S" },
    id: "agent-scout",
    jobLine: "Finds leads",
    name: "Sales Scout",
  },
  {
    avatar: { color: "green", glyph: "W" },
    id: "agent-writer",
    jobLine: "Writes drafts",
    name: "Writer",
  },
];

const channels: TeamSlackChannels = {
  channels: [
    { id: "C1", isPrivate: false, name: "ops" },
    { id: "C2", isPrivate: true, name: "design" },
  ],
  slackTeamId: "T1",
};

const unlinked: TeamSlackStatus = {
  apps: [],
  channelName: null,
  link: null,
};

const linkedTo = (
  apps: TeamSlackMemberApp[],
  channelId = "C1",
  channelName: string | null = "ops"
): TeamSlackStatus => ({
  apps,
  channelName,
  link: {
    channelId,
    createdAt: "2026-11-01T00:00:00.000Z",
    linkedBy: "user-1",
    slackTeamId: "T1",
    teamId: "team-1",
  },
});

const APOSTROPHE_ENTITY = /&#x27;/g;
const PICK_OPTION = /<option[^>]*value=""[^>]*>Pick a channel<\/option>/;
const BUTTON_OPENING = /<button[^>]*>/g;
const SELECT_OPENING = /<select[^>]*>/;
const LINK_BUTTON_DISABLED =
  /<button[^>]* disabled=""[^>]*>Link channel<\/button>/;
const UNLINK_BUTTON = /<button[^>]*>Unlink<\/button>/;
const UNLINK_BUTTON_DISABLED = /<button[^>]* disabled=""[^>]*>Unlink<\/button>/;
const ALERT = /<p[^>]*role="alert"[^>]*>/;
const LIST_ITEM = /<li[^>]*>/g;

/** The markup with apostrophes unescaped, so the expected text reads as the page shows it. */
const render = (
  props: Partial<SlackSectionProps> & { status: TeamSlackStatus }
): string =>
  renderToStaticMarkup(
    <SlackSection
      agents={agents}
      busy={false}
      canEdit
      channels={channels}
      channelsError={null}
      error={null}
      onLink={noLink}
      onUnlink={noop}
      {...props}
    />
  ).replace(APOSTROPHE_ENTITY, "'");

test("an unlinked reader sees that the room is not linked, with no select or button", () => {
  const html = render({ canEdit: false, channels: null, status: unlinked });
  expect(html).toContain("This team's room is not linked to a Slack channel.");
  expect(html).not.toMatch(SELECT_OPENING);
  expect(html).not.toContain("<button");
});

test("an unlinked editor sees the channel select with each channel, private ones marked", () => {
  const html = render({ status: unlinked });
  expect(html).toContain('for="team-slack-channel"');
  expect(html).toContain("Slack channel</label>");
  expect(html).toMatch(PICK_OPTION);
  expect(html).toContain('value="C1"');
  expect(html).toContain("#ops</option>");
  expect(html).toContain('value="C2"');
  expect(html).toContain("#design (private)</option>");
  expect(html).toContain(
    "Messages in the channel appear in the team room, and room posts go to the channel. A team links one channel, and a channel links one team."
  );
});

test("the Link channel button is disabled until a channel is picked", () => {
  const html = render({ status: unlinked });
  expect(html).toMatch(LINK_BUTTON_DISABLED);
});

test("an unlinked editor sees loading text while the channels load", () => {
  const html = render({ channels: null, status: unlinked });
  expect(html).toContain("Loading channels...");
  expect(html).not.toMatch(SELECT_OPENING);
});

test("a channel load error is shown in place of the picker", () => {
  const html = render({
    channels: null,
    channelsError: "Slack is down",
    status: unlinked,
  });
  expect(html).toMatch(ALERT);
  expect(html).toContain("Slack is down");
  expect(html).not.toContain("Loading channels...");
  expect(html).not.toMatch(SELECT_OPENING);
});

test("a team with no Slack app yet is told to add one", () => {
  const html = render({
    channels: { channels: [], slackTeamId: null },
    status: unlinked,
  });
  expect(html).toContain(
    "No agent of this team has a Slack app yet. Add a Slack app to an agent, then come back here."
  );
  expect(html).not.toMatch(SELECT_OPENING);
});

test("an app in no channels is told to invite it to a channel", () => {
  const html = render({
    channels: { channels: [], slackTeamId: "T1" },
    status: unlinked,
  });
  expect(html).toContain(
    "The lead's Slack app is in no channels. Invite it to a channel in Slack first."
  );
  expect(html).not.toMatch(SELECT_OPENING);
});

test("a linked editor sees the channel and an enabled Unlink button", () => {
  const html = render({
    status: linkedTo([]),
  });
  expect(html).toContain("Linked to #ops");
  expect(html).toMatch(UNLINK_BUTTON);
  expect(html).not.toMatch(UNLINK_BUTTON_DISABLED);
  expect(html).not.toMatch(SELECT_OPENING);
});

test("a busy linked editor sees a disabled Unlink button", () => {
  const html = render({ busy: true, status: linkedTo([]) });
  expect(html).toMatch(UNLINK_BUTTON_DISABLED);
});

test("a linked reader sees the channel and no button", () => {
  const html = render({ canEdit: false, status: linkedTo([]) });
  expect(html).toContain("Linked to #ops");
  expect(html.match(BUTTON_OPENING)).toBeNull();
});

test("a linked team with an id-only channel shows the id in place of the name", () => {
  const html = render({ status: linkedTo([], "C9", null) });
  expect(html).toContain("Linked to C9");
});

test("an agent whose Slack app is not in the channel is listed with its invite line", () => {
  const html = render({
    status: linkedTo([
      { agentId: "agent-scout", botUserId: "UB1", inChannel: false },
    ]),
  });
  expect(html).toContain("Sales Scout");
  expect(html).toContain(
    "These agents' Slack apps are not in the channel yet. Paste each line in the channel in Slack:"
  );
  expect(html).toContain(
    '<code class="rounded bg-muted px-1.5 py-0.5 text-sm">/invite @sales-scout</code>'
  );
  expect(html.match(LIST_ITEM)).toHaveLength(1);
});

test("an agent whose Slack app has no bot user says it has no Slack app yet", () => {
  const html = render({
    status: linkedTo([
      { agentId: "agent-scout", botUserId: null, inChannel: false },
    ]),
  });
  expect(html).toContain("Sales Scout");
  expect(html).toContain("has no Slack app yet");
  expect(html).not.toContain("/invite");
});

test("each missing agent gets its own list item, and an agent in the channel is not listed", () => {
  const html = render({
    status: linkedTo([
      { agentId: "agent-scout", botUserId: "UB1", inChannel: false },
      { agentId: "agent-writer", botUserId: "UB2", inChannel: true },
    ]),
  });
  expect(html.match(LIST_ITEM)).toHaveLength(1);
  expect(html).toContain("/invite @sales-scout");
  expect(html).not.toContain("Writer");
  expect(html).not.toContain("/invite @writer");
  expect(html).not.toContain("Every agent's Slack app is in the channel.");
});

test("every agent app in the channel shows the all-good line and no list", () => {
  const html = render({
    status: linkedTo([
      { agentId: "agent-scout", botUserId: "UB1", inChannel: true },
      { agentId: "agent-writer", botUserId: "UB2", inChannel: true },
    ]),
  });
  expect(html).toContain("Every agent's Slack app is in the channel.");
  expect(html).not.toContain("<ul");
});

test("a linked team with no agent apps shows neither the list nor the all-good line", () => {
  const html = render({ status: linkedTo([]) });
  expect(html).not.toContain("<ul");
  expect(html).not.toContain("Every agent's Slack app is in the channel.");
});

test("an action error is shown at the bottom in an unlinked state", () => {
  const html = render({
    error: "Could not link the channel",
    status: unlinked,
  });
  expect(html).toContain("Could not link the channel");
  expect(html).toMatch(ALERT);
});

test("an action error is shown in a linked state", () => {
  const html = render({ error: "Could not unlink", status: linkedTo([]) });
  expect(html).toContain("Could not unlink");
  expect(html).toMatch(ALERT);
});
