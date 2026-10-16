import { expect, test } from "bun:test";
import {
  AGENT_DESCRIPTION_LIMIT,
  buildManifest,
  DISPLAY_NAME_LIMIT,
  manifestJson,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  slackEventsUrl,
} from "./manifest.ts";

const ORIGIN = "https://harbour.example.com";
const DESCRIPTION = "Answers questions about the release.";

const input = (
  overrides: Partial<Parameters<typeof buildManifest>[0]> = {}
) => ({
  description: DESCRIPTION,
  name: "Release Bot",
  origin: ORIGIN,
  ...overrides,
});

test("the display name is trimmed and cut at the Slack limit", () => {
  const long = `  ${"n".repeat(50)}  `;
  const manifest = buildManifest(input({ name: long }));
  expect(manifest.display_information.name).toBe(
    "n".repeat(DISPLAY_NAME_LIMIT)
  );
  expect(DISPLAY_NAME_LIMIT).toBe(35);
});

test("an empty or blank name falls back to Agent", () => {
  expect(buildManifest(input({ name: "" })).display_information.name).toBe(
    "Agent"
  );
  expect(buildManifest(input({ name: "   " })).display_information.name).toBe(
    "Agent"
  );
});

test("the bot user name is a slug of the display name", () => {
  const manifest = buildManifest(input({ name: "Q3 Report Bot!" }));
  expect(manifest.features.bot_user.display_name).toBe("q3-report-bot");
});

test("the bot user name keeps only the characters Slack allows", () => {
  const manifest = buildManifest(input({ name: "  --Rocky__Shore.v2--  " }));
  expect(manifest.features.bot_user.display_name).toBe("rocky__shore.v2");
});

test("a name with no allowed characters gets the agent fallback", () => {
  const manifest = buildManifest(input({ name: "!!!" }));
  expect(manifest.features.bot_user.display_name).toBe("agent");
});

test("the agent description is cut at 300 characters", () => {
  const long = "d".repeat(AGENT_DESCRIPTION_LIMIT + 50);
  const manifest = buildManifest(input({ description: long }));
  expect(manifest.features.agent_view.agent_description).toBe(
    "d".repeat(AGENT_DESCRIPTION_LIMIT)
  );
  expect(manifest.display_information.description).toBe("d".repeat(140));
});

test("the events URL has one slash before the path for any trailing slashes", () => {
  expect(slackEventsUrl(ORIGIN)).toBe(`${ORIGIN}/api/slack/events`);
  expect(slackEventsUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/api/slack/events`);
  expect(slackEventsUrl(`${ORIGIN}///`)).toBe(`${ORIGIN}/api/slack/events`);
  expect(
    buildManifest(input({ origin: `${ORIGIN}/` })).settings.event_subscriptions
      .request_url
  ).toBe(`${ORIGIN}/api/slack/events`);
});

test("the scopes and events are exactly the lists", () => {
  const manifest = buildManifest(input());
  expect(manifest.oauth_config.scopes.bot).toEqual([
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "files:read",
    "files:write",
    "groups:history",
    "im:history",
    "users:read",
    "users:read.email",
  ]);
  expect([...manifest.oauth_config.scopes.bot]).toEqual([...SLACK_BOT_SCOPES]);
  expect(manifest.settings.event_subscriptions.bot_events).toEqual([
    "app_mention",
    "message.im",
  ]);
  expect(SLACK_BOT_EVENTS).toEqual(["app_mention", "message.im"]);
});

test("interactivity is disabled and the other settings are fixed", () => {
  const { settings, features } = buildManifest(input());
  expect(settings.interactivity).toEqual({ is_enabled: false });
  expect(settings.org_deploy_enabled).toBe(false);
  expect(settings.socket_mode_enabled).toBe(false);
  expect(settings.token_rotation_enabled).toBe(false);
  expect(features.app_home).toEqual({
    home_tab_enabled: false,
    messages_tab_enabled: true,
    messages_tab_read_only_enabled: false,
  });
});

test("manifestJson parses back to the built manifest", () => {
  const json = manifestJson(input());
  expect(JSON.parse(json)).toEqual(buildManifest(input()));
});
