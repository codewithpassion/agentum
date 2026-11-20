import { expect, test } from "bun:test";
import type { TeamSlackStatus } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { SlackLinkBadge, slackLinkLabel } from "./room-slack-link.tsx";

const link: TeamSlackStatus["link"] = {
  channelId: "C123",
  createdAt: "2026-11-01T00:00:00.000Z",
  linkedBy: "user_1",
  slackTeamId: "T123",
  teamId: "team_1",
};

test("slackLinkLabel is null while status is not loaded", () => {
  expect(slackLinkLabel(null)).toBeNull();
});

test("slackLinkLabel is null when the team has no link", () => {
  const status: TeamSlackStatus = {
    apps: [],
    channelName: "general",
    link: null,
  };
  expect(slackLinkLabel(status)).toBeNull();
});

test("slackLinkLabel names the channel when the link has a name", () => {
  const status: TeamSlackStatus = { apps: [], channelName: "ops", link };
  expect(slackLinkLabel(status)).toBe("Slack #ops");
});

test("slackLinkLabel says linked when the channel has no name", () => {
  const status: TeamSlackStatus = { apps: [], channelName: null, link };
  expect(slackLinkLabel(status)).toBe("Slack linked");
});

test("SlackLinkBadge renders its label", () => {
  const html = renderToStaticMarkup(<SlackLinkBadge label="Slack #ops" />);
  expect(html).toContain("Slack #ops");
  expect(html).toContain("text-muted-foreground");
});
