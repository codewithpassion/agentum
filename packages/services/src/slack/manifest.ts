/**
 * The Slack app manifest builder for Harbourmaster.
 *
 * Each Harbourmaster agent is a Slack app. The owner pastes the JSON from
 * `manifestJson` into Slack's "Create app from manifest" form, then pastes the
 * bot token back. The manifest is built here, from a name, a description and
 * the public origin, so the request URL points at the deployment that is
 * asking.
 */

/**
 * Bot scopes, sorted alphabetically.
 *
 * - `app_mentions:read` receives `app_mention` events, a mention of the app in
 *   a channel it is in.
 * - `assistant:write` lets the app show a status such as "is thinking…" in a
 *   Slack thread while a run is going, through `assistant.threads.setStatus`,
 *   and is the scope Slack's manifest editor wants for apps with
 *   `features.agent_view`.
 * - `channels:history` reads messages in public channels the app is in, so it
 *   can see replies in its own threads.
 * - `channels:read` gives a public channel's name, which titles its sessions.
 * - `chat:write` posts replies and status messages.
 * - `files:read` downloads files people share with the app.
 * - `files:write` uploads files the app produces.
 * - `groups:history` does the same as `channels:history` for private channels.
 * - `groups:read` does the same as `channels:read` for private channels.
 * - `im:history` reads direct messages, which is the `message.im` event.
 * - `im:write` opens a DM with a linked member for `slack_send`.
 * - `users:read` looks up members. It also serves `bots.info`, which
 *   Harbourmaster uses to learn the app id when a token is pasted.
 * - `users:read.email` reads a member's email address to match them to an
 *   account.
 */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:write",
  "users:read",
  "users:read.email",
] as const;

/**
 * Bot events. `app_mention` and `message.im` are the two ways a person reaches
 * the agent. `message.channels` and `message.groups` deliver a reply in a
 * thread the agent started without a mention. `app_home_opened` is subscribed
 * because Slack's manifest editor wants it for apps with agent_view, and the
 * events route answers it with a 200 and does nothing else.
 */
export const SLACK_BOT_EVENTS = [
  "app_home_opened",
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
] as const;

/**
 * Slack's cap on `features.agent_view.agent_description`
 * (https://docs.slack.dev/reference/app-manifest.md#features).
 */
export const AGENT_DESCRIPTION_LIMIT = 300;
/** Slack's cap on `display_information.name`. */
export const DISPLAY_NAME_LIMIT = 35;
/** Slack's cap on `features.bot_user.display_name`, the bot's user name. */
export const BOT_NAME_LIMIT = 80;

/** Slack's cap on `display_information.description`. */
const DESCRIPTION_LIMIT = 140;
const DEFAULT_NAME = "Agent";
const DEFAULT_BOT_NAME = "agent";
const BACKGROUND_COLOR = "#1a1a1a";
const EVENTS_PATH = "/api/slack/events";
const INTERACTIONS_PATH = "/api/slack/interactions";

/** A trailing slash on a pasted origin, stripped before a URL is built. */
const TRAILING_SLASHES = /\/+$/;
/** Characters a bot user name may not contain, as runs. */
const DISALLOWED_BOT_NAME_RUN = /[^a-z0-9_.-]+/g;
/** Leading and trailing hyphens, which a bot user name may not start or end with. */
const EDGE_HYPHENS = /^-+|-+$/g;

export interface SlackAppManifest {
  display_information: {
    background_color: string;
    description: string;
    name: string;
  };
  features: {
    agent_view: { agent_description: string };
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { always_online: boolean; display_name: string };
  };
  oauth_config: {
    scopes: { bot: readonly (typeof SLACK_BOT_SCOPES)[number][] };
  };
  settings: {
    event_subscriptions: {
      bot_events: readonly (typeof SLACK_BOT_EVENTS)[number][];
      request_url: string;
    };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface BuildManifestInput {
  /** The text shown as the agent's purpose. Cut to fit each field. */
  description: string;
  /** The name the owner chose for the agent. */
  name: string;
  /** The public origin of the deployment, such as `https://example.com`. */
  origin: string;
}

/** The URL Slack posts events to, for a deployment origin. */
export const slackEventsUrl = (origin: string): string =>
  `${origin.replace(TRAILING_SLASHES, "")}${EVENTS_PATH}`;

/** The URL Slack posts button clicks and modal submissions to, for a deployment origin. */
export const slackInteractionsUrl = (origin: string): string =>
  `${origin.replace(TRAILING_SLASHES, "")}${INTERACTIONS_PATH}`;

/**
 * A bot user name from a display name: lowercase, every run of characters
 * Slack does not allow replaced by one hyphen, no leading or trailing hyphen.
 */
const botNameFrom = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(DISALLOWED_BOT_NAME_RUN, "-")
    .replace(EDGE_HYPHENS, "")
    .slice(0, BOT_NAME_LIMIT);
  return slug === "" ? DEFAULT_BOT_NAME : slug;
};

/**
 * The manifest object for one agent. Slack takes it as JSON; the keys are
 * snake_case because Slack requires that.
 *
 * `features.agent_view` is set because Slack requires it for apps created
 * after 30 June 2026, and it cannot be added to an app later. The Messages
 * tab is enabled because that is what makes the direct message with the agent
 * exist. The Messages tab is not read-only, or nobody can send the agent a
 * message. No Home tab, since the agent publishes no home view.
 *
 * Interactivity is on, so Slack sends button clicks and modal submissions to
 * the interactions URL. Token rotation is off: the owner pastes one
 * long-lived bot token.
 */
export const buildManifest = (input: BuildManifestInput): SlackAppManifest => {
  const trimmedName = input.name.trim().slice(0, DISPLAY_NAME_LIMIT);
  const name = trimmedName === "" ? DEFAULT_NAME : trimmedName;
  return {
    display_information: {
      background_color: BACKGROUND_COLOR,
      description: input.description.slice(0, DESCRIPTION_LIMIT),
      name,
    },
    features: {
      agent_view: {
        agent_description: input.description.slice(0, AGENT_DESCRIPTION_LIMIT),
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { always_online: true, display_name: botNameFrom(name) },
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: {
        bot_events: SLACK_BOT_EVENTS,
        request_url: slackEventsUrl(input.origin),
      },
      interactivity: {
        is_enabled: true,
        request_url: slackInteractionsUrl(input.origin),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
};

/** The manifest as the JSON to paste into Slack's app creation form. */
export const manifestJson = (input: BuildManifestInput): string =>
  JSON.stringify(buildManifest(input), null, 2);
