import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { listAgents } from "#/modules/agents/service";
import { createBrowserClient } from "#/modules/browser/client";
import { absoluteUrl } from "#/modules/browser/service";
import { summarizeSnapshot } from "#/modules/browser/snapshot";
import { createComputerClient } from "#/modules/computer/client";
import {
  TOOL_OUTPUT_MAX_BYTES,
  truncateText,
  withTruncationNote,
} from "#/modules/computer/output";
import { publishMessage } from "#/modules/messaging/publish";
import {
  getMessageInWorkspace,
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
import { clampLimit, fail, json, toMcpMessage } from "./format";
import { registerSkillTools } from "./skill-tools";

/**
 * The agent-facing half of the workspace. Every tool runs as the agent whose
 * token addressed the endpoint, and reaches the same module services the web
 * API uses - so anything an agent writes shows up live in the UI.
 */

export interface McpToolContext {
  agent: Agent;
  db: Db;
  env: Env;
  /** The URL this tool call arrived on, so tools can hand back absolute links. */
  requestUrl: string;
  /**
   * The agent's workspace, resolved from `agent.workspaceId` when the token was
   * accepted. Every tool query below carries it.
   */
  workspace: { id: string; slug: string };
}

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 100;
const MESSAGE_BODY_MAX_LENGTH = 50_000;
const WIKI_BODY_MAX_LENGTH = 200_000;
const WIKI_TITLE_MAX_LENGTH = 200;
const COMPUTER_CONTENT_MAX_LENGTH = 500_000;
const COMPUTER_COMMAND_MAX_LENGTH = 4000;

const agentNamesById = async (
  db: Db,
  workspaceId: string
): Promise<Map<string, string>> => {
  const all = await listAgents(db, workspaceId);
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
          members: (
            await listChannelMembers(ctx.db, ctx.agent.workspaceId, channel.id)
          ).map((member) => member.name ?? "User"),
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
        // Scoped, and not merely for correctness: an unscoped lookup answers
        // "no such message" for an id that does not exist and hands back a
        // working cursor for one that exists in another workspace, which makes
        // this parameter an existence oracle for every message in the
        // deployment. Out of the workspace and never-existed read the same.
        const before = await getMessageInWorkspace(
          ctx.db,
          ctx.workspace.id,
          beforeId
        );
        if (!before) {
          return fail(`No message with id ${beforeId}.`);
        }
        cursor = { createdAt: before.createdAt.getTime(), id: before.id };
      }

      const page = await listChannelMessages(ctx.db, ctx.workspace, {
        channelId,
        cursor,
        limit: clampLimit(limit, {
          fallback: DEFAULT_MESSAGE_LIMIT,
          max: MAX_MESSAGE_LIMIT,
        }),
      });
      const names = await agentNamesById(ctx.db, ctx.workspace.id);
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
      const thread = await getThread(ctx.db, ctx.workspace, messageId);
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

      const names = await agentNamesById(ctx.db, ctx.workspace.id);
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
        workspace: ctx.workspace,
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
      const all = await listAgents(ctx.db, ctx.workspace.id);
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
        "List every wiki page (slug and title). The wiki is the workspace's shared long-term memory: put anything worth keeping there instead of repeating it in chat. Slugs are paths, so a slug like ops/runbooks/deploy is a page nested under Ops > Runbooks.",
      inputSchema: {},
      title: "List wiki pages",
    },
    async () => json({ pages: await listPages(ctx.db, ctx.workspace.id) })
  );

  server.registerTool(
    "wiki_read",
    {
      description: "Read a wiki page's markdown body by slug.",
      inputSchema: { slug: z.string() },
      title: "Read a wiki page",
    },
    async ({ slug }) => {
      const page = await getPageBySlug(ctx.db, ctx.workspace.id, slug);
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
        'Create or replace a wiki page. Omit slug to address the page by its title (the slug is derived from it); pass slug to edit an existing page whose title you are also changing. A "/" in the title nests the page: "Ops/Runbooks/Deploy" lives under Ops > Runbooks and is called "Deploy" there. The body is markdown and replaces the page wholesale, so read the page first when editing. The revision is recorded under your name.',
      inputSchema: {
        body: z.string().max(WIKI_BODY_MAX_LENGTH),
        slug: z.string().optional(),
        title: z.string().max(WIKI_TITLE_MAX_LENGTH),
      },
      title: "Write a wiki page",
    },
    async ({ body, slug, title }) => {
      const { created, page } = await writePage(ctx.db, ctx.workspace.id, {
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
    async ({ query }) =>
      json({ pages: await searchPages(ctx.db, ctx.workspace.id, query) })
  );
};

// --- computer ----------------------------------------------------------------

const COMPUTER_INTRO =
  "Your private computer - a filesystem only you can reach, whose files persist between sessions.";

const registerComputerFileTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  const computer = () => createComputerClient(ctx.db, ctx.env, ctx.agent.id);

  server.registerTool(
    "computer_read_file",
    {
      description: `${COMPUTER_INTRO} Read a file's contents by absolute path. Large files are refused rather than silently cut, so list the directory first if you are unsure of the size.`,
      inputSchema: {
        path: z.string().describe('Absolute path, e.g. "/notes/plan.md".'),
      },
      title: "Read a file on your computer",
    },
    async ({ path }) => {
      const result = await computer().readFile(path);
      return result.ok
        ? json({ content: result.content, path, size: result.size })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "computer_write_file",
    {
      description: `${COMPUTER_INTRO} Create or overwrite a file at an absolute path; missing parent directories are created for you. This replaces the whole file - use computer_edit_file to change part of one.`,
      inputSchema: {
        content: z.string().max(COMPUTER_CONTENT_MAX_LENGTH),
        path: z.string().describe('Absolute path, e.g. "/notes/plan.md".'),
      },
      title: "Write a file on your computer",
    },
    async ({ content, path }) => {
      const result = await computer().writeFile(path, content);
      return result.ok
        ? json({ created: result.created, path, size: result.size })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "computer_edit_file",
    {
      description: `${COMPUTER_INTRO} Replace one exact string in a file with another. old_string must appear exactly once, so include enough surrounding lines to make it unique; read the file first if you are not sure.`,
      inputSchema: {
        new_string: z.string().describe("What to put in its place."),
        old_string: z
          .string()
          .describe("The exact text to replace, including whitespace."),
        path: z.string(),
      },
      title: "Edit a file on your computer",
    },
    async ({ new_string, old_string, path }) => {
      const result = await computer().editFile(path, old_string, new_string);
      return result.ok
        ? json({ path, size: result.size })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "computer_list_dir",
    {
      description: `${COMPUTER_INTRO} List the entries in a directory, marking which are directories. Start at "/" to see everything you have.`,
      inputSchema: {
        path: z.string().describe('Absolute directory path; "/" is the root.'),
      },
      title: "List a directory on your computer",
    },
    async ({ path }) => {
      const result = await computer().listDir(path);
      return result.ok
        ? json({ entries: result.entries, path })
        : fail(result.reason);
    }
  );
};

const registerComputerExec = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "computer_exec",
    {
      description: `${COMPUTER_INTRO} Run a shell command against those files and get back its stdout, stderr and exit code. The working directory is "/" and the shell is a small POSIX one - expect coreutils-style commands, not a package manager. Long output is truncated with a note saying so.`,
      inputSchema: {
        command: z
          .string()
          .max(COMPUTER_COMMAND_MAX_LENGTH)
          .describe('A shell command, e.g. "wc -l /notes/plan.md".'),
      },
      title: "Run a command on your computer",
    },
    async ({ command }) => {
      const result = await createComputerClient(
        ctx.db,
        ctx.env,
        ctx.agent.id
      ).exec(command);
      if (!result.ok) {
        return fail(result.reason);
      }
      return json({
        exitCode: result.exitCode,
        stderr: withTruncationNote(
          truncateText(result.stderr, TOOL_OUTPUT_MAX_BYTES)
        ),
        stdout: withTruncationNote(
          truncateText(result.stdout, TOOL_OUTPUT_MAX_BYTES)
        ),
      });
    }
  );
};

// --- browser ------------------------------------------------------------------

const BROWSER_INTRO =
  "Your own browser - one page, kept open between tool calls, so what you navigate to is still there next time.";

const registerBrowserTools = (server: McpServer, ctx: McpToolContext): void => {
  const browser = () =>
    createBrowserClient(ctx.db, ctx.env, ctx.workspace, ctx.agent.id);

  server.registerTool(
    "browser_navigate",
    {
      description: `${BROWSER_INTRO} Open an http or https URL and get back the page's title and the start of its content. Private and loopback addresses are refused.`,
      inputSchema: {
        url: z.string().describe('Absolute URL, e.g. "https://example.com".'),
      },
      title: "Open a page in your browser",
    },
    async ({ url }) => {
      const result = await browser().navigate(url);
      return result.ok
        ? json({
            summary: summarizeSnapshot(result.snapshot),
            title: result.snapshot.title,
            url: result.snapshot.url,
          })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "browser_snapshot",
    {
      description: `${BROWSER_INTRO} Read the page that is currently open: its title, visible text, and every link on it with the URL each one goes to. This is how you decide what to click next.`,
      inputSchema: {},
      title: "Read the open page",
    },
    async () => {
      const result = await browser().snapshot();
      return result.ok ? json(result.snapshot) : fail(result.reason);
    }
  );

  server.registerTool(
    "browser_click",
    {
      description: `${BROWSER_INTRO} Click the first element matching a CSS selector, then read the page back - so a click that follows a link returns the page it landed on. Take a browser_snapshot first if you are unsure what to target.`,
      inputSchema: {
        selector: z
          .string()
          .describe('A CSS selector, e.g. "a[href=\'/docs\']" or "#submit".'),
      },
      title: "Click on the open page",
    },
    async ({ selector }) => {
      const result = await browser().click(selector);
      return result.ok
        ? json({
            summary: summarizeSnapshot(result.snapshot),
            url: result.snapshot.url,
          })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "browser_fill",
    {
      description: `${BROWSER_INTRO} Type a value into the input, textarea or select matching a CSS selector, replacing whatever is in it. Submit the form afterwards with browser_click.`,
      inputSchema: {
        selector: z.string().describe('A CSS selector, e.g. "input[name=q]".'),
        value: z.string().describe("The text to put in the field."),
      },
      title: "Fill a field on the open page",
    },
    async ({ selector, value }) => {
      const result = await browser().fill(selector, value);
      return result.ok
        ? json({ filled: result.selector, url: result.url })
        : fail(result.reason);
    }
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: `${BROWSER_INTRO} Capture the page as a PNG. It is saved in the workspace and the returned URL renders inline in a message or a wiki page, so link to it when what you saw is worth showing.`,
      inputSchema: {},
      title: "Screenshot the open page",
    },
    async () => {
      const result = await browser().screenshot();
      if (!result.ok) {
        return fail(result.reason);
      }
      const { screenshot } = result;
      return json({
        markdown: `![Screenshot of ${screenshot.pageUrl}](${absoluteUrl(ctx.env.PUBLIC_APP_URL, ctx.requestUrl, screenshot.url)})`,
        pageUrl: screenshot.pageUrl,
        url: absoluteUrl(
          ctx.env.PUBLIC_APP_URL,
          ctx.requestUrl,
          screenshot.url
        ),
      });
    }
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
  registerSkillTools(server, ctx);
  registerComputerFileTools(server, ctx);
  registerComputerExec(server, ctx);
  registerBrowserTools(server, ctx);
};
