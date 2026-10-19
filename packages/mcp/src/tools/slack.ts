import { z } from "zod";
import type { McpPorts, SlackDestinations, SlackSendResult } from "../ports";
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
    annotations: WRITE_CREATE,
    description:
      "Starts a message in Slack. `to` is a channel the agent's bot is in (#name or channel id) or a linked workspace member (their email or Slack name). Nobody else can be reached. Every send is logged in the workspace Log with its target and length, never its text. The limit is 30 sends per hour per agent. Pass thread_ts, the ts an earlier slack_send returned in the same channel or DM, to continue that thread.",
    inputSchema: z.strictObject({
      text: z.string().trim().min(1).max(4000).describe("The message to send."),
      thread_ts: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "The ts of a message this agent started with slack_send in the same channel or DM. The new message goes into that thread."
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
