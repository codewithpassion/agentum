/**
 * The connector's identity, stored in `origin`, `external_refs.connector` and
 * bridge rows. Credentials are not here: they belong to a `slack_apps` row now,
 * one per connected agent, rather than to the deployment.
 */

export const SLACK_CONNECTOR = "slack";
export const SLACK_LABEL = "Slack";
