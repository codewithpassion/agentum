import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { listAgents } from "#/modules/agents/service";
import { publishMessage } from "#/modules/messaging/publish";
import {
  getMessage,
  getThread,
  isChannelMember,
  listChannelMembers,
  listChannelMessages,
  listChannelsForMember,
  type MessageCursor,
} from "#/modules/messaging/service";
import {
  getPageBySlug,
  listPages,
  searchPages,
  toPageView,
  writePage,
} from "#/modules/wiki/service";
import { clampLimit, toMcpMessage } from "./format";

/**
 * The agent-facing half of the workspace. Every tool runs as the agent whose
 * token addressed the endpoint, and reaches the same module services the web
 * API uses - so anything an agent writes shows up live in the UI.
 */

export interface McpToolContext {
  agent: Agent;
  db: Db;
  env: Env;
}

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 100;
const MESSAGE_BODY_MAX_LENGTH = 50_000;
const WIKI_BODY_MAX_LENGTH = 200_000;
const WIKI_TITLE_MAX_LENGTH = 200;

const json = (payload: unknown): CallToolResult => ({
  content: [{ text: JSON.stringify(payload), type: "text" }],
});

const fail = (message: string): CallToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

const agentNamesById = async (db: Db): Promise<Map<string, string>> => {
  const all = await listAgents(db);
  return new Map(all.map((agent) => [agent.id, agent.name]));
};

const memberOf = (agent: Agent) =>
  ({ memberId: agent.id, memberType: "agent" }) as const;

const NOT_A_MEMBER =
  "You are not a member of that channel. Use list_channels to see the channels you can read and post in.";

// --- messaging ---------------------------------------------------------------

const registerListChannels = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "list_channels",
    {
      description:
        "List the channels and DMs you are a member of, with their members. Start here: you can only read and post in these.",
      inputSchema: {},
      title: "List channels",
    },
    async () => {
      const channels = await listChannelsForMember(ctx.db, memberOf(ctx.agent));
      const withMembers = await Promise.all(
        channels.map(async (channel) => ({
          id: channel.id,
          kind: channel.kind,
          members: (await listChannelMembers(ctx.db, channel.id)).map(
            (member) => member.name ?? "User"
          ),
          name: channel.name,
        }))
      );
      return json({ channels: withMembers });
    }
  );
};

const registerReadChannel = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "read_channel",
    {
      description:
        "Read a channel's messages, oldest first. Returns top-level messages only; a message with replyCount > 0 has a thread, which you read with read_thread. Page backwards by passing the id of the oldest message you received as beforeId.",
      inputSchema: {
        beforeId: z
          .string()
          .optional()
          .describe("Return messages posted before this message id."),
        channelId: z.string(),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Messages to return (default ${DEFAULT_MESSAGE_LIMIT}).`),
      },
      title: "Read a channel",
    },
    async ({ beforeId, channelId, limit }) => {
      if (!(await isChannelMember(ctx.db, channelId, memberOf(ctx.agent)))) {
        return fail(NOT_A_MEMBER);
      }

      let cursor: MessageCursor | undefined;
      if (beforeId) {
        const before = await getMessage(ctx.db, beforeId);
        if (!before) {
          return fail(`No message with id ${beforeId}.`);
        }
        cursor = { createdAt: before.createdAt.getTime(), id: before.id };
      }

      const page = await listChannelMessages(ctx.db, {
        channelId,
        cursor,
        limit: clampLimit(limit, {
          fallback: DEFAULT_MESSAGE_LIMIT,
          max: MAX_MESSAGE_LIMIT,
        }),
      });
      const names = await agentNamesById(ctx.db);
      return json({
        hasMore: page.nextCursor !== null,
        messages: page.messages
          .map((message) => toMcpMessage(message, names))
          .reverse(),
      });
    }
  );
};

const registerReadThread = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "read_thread",
    {
      description:
        "Read a thread: the parent message plus its replies, oldest first. Pass the id of the message the thread hangs off.",
      inputSchema: { messageId: z.string() },
      title: "Read a thread",
    },
    async ({ messageId }) => {
      const thread = await getThread(ctx.db, messageId);
      if (!thread) {
        return fail(`No message with id ${messageId}.`);
      }
      if (
        !(await isChannelMember(
          ctx.db,
          thread.parent.channelId,
          memberOf(ctx.agent)
        ))
      ) {
        return fail(NOT_A_MEMBER);
      }

      const names = await agentNamesById(ctx.db);
      return json({
        parent: toMcpMessage(thread.parent, names),
        replies: thread.replies.map((reply) => toMcpMessage(reply, names)),
      });
    }
  );
};

const registerPostMessage = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "post_message",
    {
      description:
        "Post a message to a channel as yourself. The body is markdown. Mention another agent with @Name (exactly as list_agents spells it) to notify them - that is how you hand work over or ask a question. Reply inside a thread by passing threadParentId; otherwise the message starts a new top-level thread.",
      inputSchema: {
        body: z.string().max(MESSAGE_BODY_MAX_LENGTH),
        channelId: z.string(),
        threadParentId: z
          .string()
          .optional()
          .describe("Id of the top-level message to reply under."),
      },
      title: "Post a message",
    },
    async ({ body, channelId, threadParentId }) => {
      if (!(await isChannelMember(ctx.db, channelId, memberOf(ctx.agent)))) {
        return fail(NOT_A_MEMBER);
      }

      const result = await publishMessage(ctx.db, ctx.env, {
        authorId: ctx.agent.id,
        authorType: "agent",
        body,
        channelId,
        threadParentId,
      });
      if (!result.ok) {
        return fail(result.reason);
      }
      return json({
        mentioned: result.message.mentions.map((mention) => mention.name),
        messageId: result.message.id,
      });
    }
  );
};

const registerListAgents = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "list_agents",
    {
      description:
        "List every agent in the workspace, including yourself, with the personality each one was given. Use it to pick who to delegate to, then mention them by their `mention` string in a post_message body.",
      inputSchema: {},
      title: "List agents",
    },
    async () => {
      const all = await listAgents(ctx.db);
      return json({
        agents: all.map((agent) => ({
          id: agent.id,
          isYou: agent.id === ctx.agent.id,
          mention: `@${agent.name}`,
          name: agent.name,
          soul: agent.soul,
        })),
      });
    }
  );
};

// --- wiki --------------------------------------------------------------------

const registerWikiTools = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "wiki_list",
    {
      description:
        "List every wiki page (slug and title). The wiki is the workspace's shared long-term memory: put anything worth keeping there instead of repeating it in chat.",
      inputSchema: {},
      title: "List wiki pages",
    },
    async () => json({ pages: await listPages(ctx.db) })
  );

  server.registerTool(
    "wiki_read",
    {
      description: "Read a wiki page's markdown body by slug.",
      inputSchema: { slug: z.string() },
      title: "Read a wiki page",
    },
    async ({ slug }) => {
      const page = await getPageBySlug(ctx.db, slug);
      if (!page) {
        return fail(`No wiki page with slug ${slug}.`);
      }
      return json({ page: toPageView(page) });
    }
  );

  server.registerTool(
    "wiki_write",
    {
      description:
        "Create or replace a wiki page. Omit slug to address the page by its title (the slug is derived from it); pass slug to edit an existing page whose title you are also changing. The body is markdown and replaces the page wholesale, so read the page first when editing. The revision is recorded under your name.",
      inputSchema: {
        body: z.string().max(WIKI_BODY_MAX_LENGTH),
        slug: z.string().optional(),
        title: z.string().max(WIKI_TITLE_MAX_LENGTH),
      },
      title: "Write a wiki page",
    },
    async ({ body, slug, title }) => {
      const { created, page } = await writePage(ctx.db, {
        author: { id: ctx.agent.id, type: "agent" },
        body,
        slug,
        title,
      });
      return json({ created, slug: page.slug, title: page.title });
    }
  );

  server.registerTool(
    "wiki_search",
    {
      description:
        "Find wiki pages whose title or body contains the query (plain substring match, not semantic). Returns slugs and titles to read with wiki_read.",
      inputSchema: { query: z.string() },
      title: "Search the wiki",
    },
    async ({ query }) => json({ pages: await searchPages(ctx.db, query) })
  );
};

export const registerWorkspaceTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  registerListChannels(server, ctx);
  registerReadChannel(server, ctx);
  registerReadThread(server, ctx);
  registerPostMessage(server, ctx);
  registerListAgents(server, ctx);
  registerWikiTools(server, ctx);
};
