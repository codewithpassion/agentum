/**
 * `slack_history` and `slack_search`: an agent reads a channel or thread from
 * Slack, or searches the messages the Slack app has stored. History only reads
 * channels the bot is in, so a channel it was not invited to is refused before
 * Slack is asked. Search reads our own database and needs Slack only to turn a
 * channel name into an id.
 */
import type { Database } from "@repo/db";
import { ServiceError } from "./errors.ts";
import type { SlackClient, SlackFetch } from "./slack/client.ts";
import { SEARCH_LIMIT_MAX, searchMessages } from "./slack/messages.ts";
import { nameUsers } from "./slack/names.ts";
import {
  createAgentClients,
  type RunPrincipal,
  requireRun,
  slackFailure,
} from "./slack/run-app.ts";
import type { Principal } from "./workspaces.ts";

export interface SlackHistoryOptions {
  db: Database;
  fetch: SlackFetch;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}

export interface HistoryInput {
  channel: string;
  cursor?: string;
  limit?: number;
  since?: string;
  threadTs?: string;
  until?: string;
}

export interface SearchInput {
  channel?: string;
  limit?: number;
  person?: string;
  query: string;
  since?: string;
  until?: string;
}

const HISTORY_ACTION = "slack.history";
const SEARCH_ACTION = "slack.search";
const HISTORY_TOOL = "slack_history";
const SEARCH_TOOL = "slack_search";
const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX = 200;
const SEARCH_LIMIT_DEFAULT = 20;
const QUERY_MAX = 200;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const LEADING_SIGIL = /^#/;

/** A message as the agent reads it. `time` is ISO 8601, taken from the Slack ts. */
export interface HistoryEntry {
  author: string;
  text: string;
  threadTs: string | null;
  time: string;
  ts: string;
}

export interface SearchEntry extends HistoryEntry {
  channel: string;
}

const notInChannel = (channel: string): ServiceError =>
  new ServiceError(
    "not_found",
    `The bot is not in "${channel}". Ask a person to add it with /invite in that channel, or pick one from slack_destinations.`
  );

/** Parses a date the agent sent, in milliseconds since the epoch. */
const parseDate = (value: string, field: string): number => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ServiceError(
      "invalid",
      `${field} must be a date, such as 2026-10-16T10:00:00Z.`
    );
  }
  return ms;
};

/** Both bounds, parsed, with `since` not after `until`. */
const windowOf = ({ since, until }: { since?: string; until?: string }) => {
  const sinceMs = since === undefined ? undefined : parseDate(since, "since");
  const untilMs = until === undefined ? undefined : parseDate(until, "until");
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new ServiceError("invalid", "since must be before until.");
  }
  return { since: sinceMs, until: untilMs };
};

/** Slack ts strings are seconds with a fraction, so the time is the part before the dot. */
const timeOf = (ts: string): string =>
  new Date(Math.trunc(Number(ts)) * 1000).toISOString();

/** Looks a channel up by id or by name, with or without `#`, among the channels the bot is in. */
const findChannel = async (client: SlackClient, channel: string) => {
  const bare = channel.replace(LEADING_SIGIL, "");
  const lower = bare.toLowerCase();
  const result = await client.listChannels();
  if (result.kind !== "ok") {
    throw slackFailure(result);
  }
  const found = result.channels.find(
    (candidate) =>
      candidate.id === bare || candidate.name.toLowerCase() === lower
  );
  if (!found) {
    throw notInChannel(channel);
  }
  return found;
};

export const createSlackHistoryService = ({
  db,
  fetch: slackFetch,
  secretsKey,
}: SlackHistoryOptions) => {
  const agentClient = createAgentClients({
    db,
    fetch: slackFetch,
    secretsKey,
  });
  const requireHistoryRun = (principal: Principal): RunPrincipal =>
    requireRun(principal, HISTORY_ACTION, HISTORY_TOOL);
  const requireSearchRun = (principal: Principal): RunPrincipal =>
    requireRun(principal, SEARCH_ACTION, SEARCH_TOOL);

  const history = async (principal: Principal, input: HistoryInput) => {
    const run = requireHistoryRun(principal);
    const { client } = await agentClient(run);

    const limit = input.limit ?? HISTORY_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
      throw new ServiceError(
        "invalid",
        `limit must be a whole number from 1 to ${HISTORY_LIMIT_MAX}.`
      );
    }
    const window = windowOf(input);
    const channel = await findChannel(client, input.channel);

    // Slack reads its bounds as seconds with six decimals.
    const request = {
      channel: channel.id,
      cursor: input.cursor,
      latest:
        window.until === undefined
          ? undefined
          : (window.until / 1000).toFixed(6),
      limit,
      oldest:
        window.since === undefined
          ? undefined
          : (window.since / 1000).toFixed(6),
    };
    const page =
      input.threadTs === undefined
        ? await client.history(request)
        : await client.replies({ ...request, ts: input.threadTs });
    if (page.kind !== "ok") {
      throw slackFailure(page);
    }

    // Slack lists a channel newest first. A thread is already oldest first.
    const ordered =
      input.threadTs === undefined
        ? [...page.messages].reverse()
        : page.messages;
    const userIds = ordered.flatMap((message) =>
      message.user === null ? [] : [message.user]
    );
    const names = await nameUsers(client, userIds);

    return {
      channel: channel.id,
      messages: ordered.map(
        (message): HistoryEntry => ({
          author:
            (message.user === null ? undefined : names.get(message.user)) ??
            message.user ??
            (message.botId === null ? "unknown" : `bot ${message.botId}`),
          text: message.text,
          threadTs: message.threadTs,
          time: timeOf(message.ts),
          ts: message.ts,
        })
      ),
      nextCursor: page.nextCursor,
    };
  };

  const search = async (principal: Principal, input: SearchInput) => {
    const run = requireSearchRun(principal);
    const { app, client } = await agentClient(run);

    const query = input.query.trim();
    if (query.length < 1 || query.length > QUERY_MAX) {
      throw new ServiceError(
        "invalid",
        `The query must be 1 to ${QUERY_MAX} characters.`
      );
    }
    const limit = input.limit ?? SEARCH_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
      throw new ServiceError(
        "invalid",
        `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}.`
      );
    }
    const window = windowOf(input);

    // An id is used as it is. Only a name needs Slack to find the id.
    let channelId: string | undefined;
    if (input.channel !== undefined) {
      const bare = input.channel.replace(LEADING_SIGIL, "");
      channelId = CHANNEL_ID.test(bare)
        ? bare
        : (await findChannel(client, input.channel)).id;
    }

    const hits = await searchMessages(db, {
      appId: app.id,
      channelId,
      limit,
      person: input.person,
      query,
      since:
        window.since === undefined
          ? undefined
          : new Date(window.since).toISOString(),
      teamId: app.teamId,
      until:
        window.until === undefined
          ? undefined
          : new Date(window.until).toISOString(),
      workspaceId: run.workspaceId,
    });

    return {
      hits: hits.map(
        (hit): SearchEntry => ({
          author: hit.clerkEmail ?? hit.slackUserId,
          channel: hit.channelId,
          text: hit.text,
          threadTs: hit.threadTs,
          time: timeOf(hit.ts),
          ts: hit.ts,
        })
      ),
    };
  };

  return { history, search };
};

export type SlackHistoryService = ReturnType<typeof createSlackHistoryService>;
