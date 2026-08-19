import type { ConnectorStatus } from "../types";

/**
 * Credentials live in `.env*` (Wrangler convention) and their absence is the
 * off switch: with no signing secret we cannot trust an inbound request, and
 * with no bot token we cannot post. The UI is told which one is missing.
 */

export const SLACK_CONNECTOR = "slack";
export const SLACK_LABEL = "Slack";

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

export const readSlackConfig = (env: Env): SlackConfig | null => {
  const botToken = env.SLACK_BOT_TOKEN;
  const signingSecret = env.SLACK_SIGNING_SECRET;
  return botToken && signingSecret ? { botToken, signingSecret } : null;
};

export const slackConnectorStatus = (env: Env): ConnectorStatus => {
  const missing = [
    ...(env.SLACK_BOT_TOKEN ? [] : ["SLACK_BOT_TOKEN"]),
    ...(env.SLACK_SIGNING_SECRET ? [] : ["SLACK_SIGNING_SECRET"]),
  ];
  return {
    configured: missing.length === 0,
    connector: SLACK_CONNECTOR,
    label: SLACK_LABEL,
    missing,
  };
};
