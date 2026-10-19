import { z } from "zod";
import type {
  McpPorts,
  SlackDestinations,
  SlackHistory,
  SlackHistoryMessage,
  SlackSearchHit,
  SlackSearchResult,
  SlackSendResult,
} from "../ports";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_CREATE,
} from "./define";

const channelLine = (channel: SlackDestinations["channels"][number]): string =>
  `#${channel.name} (${channel.id}, ${channel.isPrivate ? "private" : "public"})`;

const personLine = (person: SlackDestinations["people"][number]): string =>
  `${person.email} as ${person.slackName}`;

const destinationsText = (destinations: SlackDestinations): string => {
  const channels =
    destinations.channels.length > 0
      ? destinations.channels.map(channelLine)
      : [
          "No channels. The Slack bot is in no channel yet. Ask a person to add it with /invite in a channel.",
        ];
  const people =
    destinations.people.length > 0
      ? destinations.people.map(personLine)
      : ["No linked people."];
  return [...channels, ...people].join("\n");
};

const sendText = (result: SlackSendResult): string => {
  const link = result.permalink ? ` Link: ${result.permalink}` : "";
  return `Sent to ${result.to} in ${result.channel}, ts ${result.ts}.${link}`;
};

const threadPart = (threadTs: string | null): string =>
  threadTs ? `, thread ${threadTs}` : "";

const historyLine = (message: SlackHistoryMessage): string =>
  `[${message.time}] ${message.author} (ts ${message.ts}${threadPart(message.threadTs)}): ${message.text}`;

const historyText = (history: SlackHistory): string => {
  const lines = history.messages.map(historyLine);
  if (history.nextCursor) {
    lines.push(`More messages: pass cursor "${history.nextCursor}".`);
  } else if (lines.length === 0) {
    lines.push("No messages.");
  }
  return lines.join("\n");
};

const searchLine = (hit: SlackSearchHit): string =>
  `[${hit.time}] ${hit.author} in ${hit.channel} (ts ${hit.ts}${threadPart(hit.threadTs)}): ${hit.text}`;

const searchText = (result: SlackSearchResult): string =>
  result.hits.length > 0
    ? result.hits.map(searchLine).join("\n")
    : "No matches.";

export const slackTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists where slack_send can reach: the channels the agent's Slack bot is a member of, and the people who linked their Slack account to Harbourmaster (for DMs). Nobody else can be messaged. Use a channel name or a person's email as the `to` of slack_send.",
    inputSchema: z.strictObject({}),
    name: "slack_destinations",
    run: async () => {
      const destinations = await ports.slackDestinations();
      return {
        data: destinations,
        text: destinationsText(destinations),
      };
    },
    title: "List Slack destinations",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Reads messages live from Slack, from one channel the agent's bot is a member of (see slack_destinations) or, with thread_ts, from one thread. since and until bound the time range. At most 200 messages per call, oldest first. When the answer has a next cursor, pass it as `cursor` to read the next page. The bot can read only channels it is in.",
    inputSchema: z.strictObject({
      channel: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "The channel as #name or its id, one the bot is a member of."
        ),
      cursor: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The cursor from the 'More messages' line of an earlier call, to read the next page."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("How many messages to read, from 1 to 200."),
      since: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("The start of the time range, an ISO 8601 date-time."),
      thread_ts: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "Read this thread instead of the channel: the ts of its parent message."
        ),
      until: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("The end of the time range, an ISO 8601 date-time."),
    }),
    name: "slack_history",
    run: async (input) => {
      const history = await ports.slackHistory(input);
      return {
        data: history,
        text: historyText(history),
      };
    },
    title: "Read Slack history",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      'Full-text search over the Slack messages Harbourmaster stored for this agent. It covers only messages stored since "All messages in its channels" was turned on for the agent\'s Slack app, plus the messages that mentioned the agent or replied in its threads, so it does not see older history (use slack_history for that). Every word of the query must appear, case does not matter. Results are newest first, at most 50.',
    inputSchema: z.strictObject({
      channel: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Only messages from this channel, as #name or its id."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many hits to return, from 1 to 50."),
      person: z
        .string()
        .min(1)
        .optional()
        .describe("Only messages by this person: a Slack user id or an email."),
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("Words that must all appear in the message."),
      since: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("The start of the time range, an ISO 8601 date-time."),
      until: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("The end of the time range, an ISO 8601 date-time."),
    }),
    name: "slack_search",
    run: async (input) => {
      const result = await ports.slackSearch(input);
      return {
        data: result,
        text: searchText(result),
      };
    },
    title: "Search Slack messages",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Starts a message in Slack. `to` is a channel the agent's bot is in (#name or channel id) or a linked workspace member (their email or Slack name). Nobody else can be reached. Every send is logged in the workspace Log with its target and length, never its text. The limit is 30 sends per hour per agent. Pass thread_ts to reply in a thread: the ts of a message this agent started with slack_send, or of a message (or thread parent) that slack_history, slack_search or a batch of channel messages showed, in the same channel.",
    inputSchema: z.strictObject({
      text: z.string().trim().min(1).max(4000).describe("The message to send."),
      thread_ts: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "The ts of a message this agent started with slack_send, or of a message (or thread parent) that slack_history, slack_search or a batch of channel messages showed, in the same channel or DM. The new message goes into that thread."
        ),
      to: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "A channel as #name or its id, or a person's email or Slack name, as slack_destinations lists them."
        ),
    }),
    name: "slack_send",
    run: async (input) => {
      const result = await ports.slackSend(input);
      return {
        data: result,
        text: sendText(result),
      };
    },
    title: "Send Slack message",
  }),
];
