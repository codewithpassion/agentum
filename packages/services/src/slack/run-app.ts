/**
 * What the agent-facing Slack services share: the run check, the agent's
 * installed Slack app with a client for its bot token, and the refusals a
 * failed Slack call turns into.
 */
import type { Database } from "@repo/db";
import { slackApps } from "@repo/db/schema/slack";
import { and, asc, eq } from "drizzle-orm";
import { authorize } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { createSecretReader, type SlackAppRow } from "./apps.ts";
import {
  createSlackClient,
  type SlackCallResult,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";

export type RunPrincipal = Extract<Principal, { kind: "run" }>;
export type FailedResult = Exclude<SlackCallResult, { kind: "ok" }>;

export const NO_APP =
  "This agent has no Slack app installed. Ask a workspace owner to install one for it in Harbourmaster, then try again.";
export const MISSING_SCOPE =
  "The agent's Slack app is missing a permission (missing_scope). A workspace owner must add the im:write scope (and the message.channels and message.groups events) to the app in Slack, reinstall it, and paste the new bot token in Harbourmaster.";

/** Turns a failed Slack call into the refusal an agent can act on. */
export const slackFailure = (result: FailedResult): ServiceError => {
  if (result.kind === "config") {
    if (
      result.error === "not_in_channel" ||
      result.error === "channel_not_found"
    ) {
      return new ServiceError(
        "conflict",
        "The bot is not in that channel. Ask a person to add it with /invite, or pick one from slack_destinations."
      );
    }
    return result.error === "missing_scope"
      ? new ServiceError("conflict", MISSING_SCOPE)
      : new ServiceError(
          "conflict",
          `Slack refused: ${result.error}. The app may need to be reinstalled.`
        );
  }
  if (result.kind === "rate_limited") {
    return new ServiceError(
      "conflict",
      `Slack is rate limiting this app. Try again in ${result.retryAfterSeconds} seconds.`
    );
  }
  if (result.kind === "transient") {
    return new ServiceError(
      "conflict",
      "Slack did not answer. Try again in a moment."
    );
  }
  return new ServiceError(
    "conflict",
    `Slack refused the message: ${result.error}.`
  );
};

/** Refuses anything but an agent run, then checks the caller may use `action`. */
export const requireRun = (
  principal: Principal,
  action: string,
  toolNames: string
): RunPrincipal => {
  if (principal.kind !== "run") {
    throw new ServiceError(
      "invalid",
      `${toolNames} work only inside an agent run.`
    );
  }
  authorize(principal, action, {
    kind: "slack",
    workspaceId: principal.workspaceId,
  });
  return principal;
};

/** Reads the agent's oldest installed Slack app and a client for its bot token. */
export const createAgentClients = ({
  db,
  fetch: slackFetch,
  secretsKey,
}: {
  db: Database;
  fetch: SlackFetch;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}) => {
  const secrets = createSecretReader(secretsKey);

  return async (
    run: RunPrincipal
  ): Promise<{ app: SlackAppRow; client: SlackClient }> => {
    const [app] = await db
      .select()
      .from(slackApps)
      .where(
        and(
          eq(slackApps.workspaceId, run.workspaceId),
          eq(slackApps.agentId, run.agentId),
          eq(slackApps.status, "installed")
        )
      )
      .orderBy(asc(slackApps.createdAt))
      .limit(1);
    const token = app ? await secrets.botToken(app) : null;
    if (!(app && token)) {
      throw new ServiceError("not_found", NO_APP);
    }
    return { app, client: createSlackClient({ fetch: slackFetch, token }) };
  };
};
