/**
 * The Slack app manifest the wizard hands the user to paste into
 * api.slack.com/apps → Create New App → From a manifest.
 *
 * It is generated rather than documented so the events URL, the scopes and the
 * subscribed events cannot drift from what the bridge actually needs: the URL
 * carries the app's row id, the scopes are exactly the calls `client.ts` makes,
 * and the events are exactly the ones `normalize.ts` publishes.
 */

const TRAILING_SLASHES = /\/+$/;
/** Slack's own caps on the manifest fields. */
const APP_NAME_MAX = 35;
const DISPLAY_NAME_MAX = 80;
const DESCRIPTION_MAX = 140;
/** A bot user's display name may not contain a period. */
const PERIODS = /\./g;

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "channels:join",
  "groups:history",
  "groups:read",
  "chat:write",
  "files:read",
  "files:write",
  "users:read",
] as const;

export const SLACK_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
] as const;

export const SLACK_EVENTS_PATH = "/api/bridges/slack";

/**
 * Where Slack posts this app's events. Built like the connectors' callback
 * URL - `PUBLIC_APP_URL` when set, the request's own origin otherwise - so a
 * tunnelled dev host and production both produce a URL Slack can reach.
 */
export const slackEventsUrl = (
  publicAppUrl: string | undefined,
  requestUrl: string,
  slackAppId: string
): string => {
  const base = publicAppUrl || new URL(requestUrl).origin;
  return `${base.replace(TRAILING_SLASHES, "")}${SLACK_EVENTS_PATH}/${slackAppId}`;
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/**
 * Every dynamic value goes through `JSON.stringify`: a JSON string is a valid
 * YAML scalar, which is what keeps an agent named `Ops: "the second"` from
 * producing a manifest Slack cannot parse.
 */
const scalar = (value: string): string => JSON.stringify(value);

const list = (items: readonly string[], indent: string): string =>
  items.map((item) => `${indent}- ${item}`).join("\n");

export interface ManifestAgent {
  name: string;
}

export const buildSlackManifest = (
  agent: ManifestAgent,
  requestUrl: string
): string => {
  const name = truncate(agent.name, APP_NAME_MAX);
  const displayName = truncate(
    agent.name.replace(PERIODS, "").trim() || name,
    DISPLAY_NAME_MAX
  );
  const description = truncate(
    `${agent.name} in Slack, through Agentum.`,
    DESCRIPTION_MAX
  );

  return `display_information:
  name: ${scalar(name)}
  description: ${scalar(description)}
features:
  bot_user:
    display_name: ${scalar(displayName)}
    always_online: true
oauth_config:
  scopes:
    bot:
${list(SLACK_BOT_SCOPES, "      ")}
settings:
  event_subscriptions:
    request_url: ${scalar(requestUrl)}
    bot_events:
${list(SLACK_BOT_EVENTS, "      ")}
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
};
