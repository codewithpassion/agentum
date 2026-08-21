import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import {
  clearOverride,
  resolveModelWithSource,
  upsertOverride,
} from "#/modules/agents/model-overrides";
import type { Agent } from "#/modules/agents/schema";
import { listAgents } from "#/modules/agents/service";
import {
  AVAILABLE_MODEL_IDS,
  AVAILABLE_MODELS,
  isAvailableModel,
} from "#/modules/anthropic/config";
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
  searchMessages,
} from "#/modules/messaging/service";
import { parseExpiresIn } from "#/modules/questions/duration";
import { QUESTION_KINDS } from "#/modules/questions/schema";
import {
  ask,
  getQuestionForAgent,
  PROMPT_MAX_LENGTH,
  resolveIfExpired,
} from "#/modules/questions/service";
import { optionsOf, toQuestionViews } from "#/modules/questions/view";
import { rescheduleQuestionExpiry } from "#/modules/routines/scheduler";
import {
  getPageBySlug,
  listPages,
  searchPages,
  toPageView,
  writePage,
} from "#/modules/wiki/service";
import {
  authorNameOf,
  clampLimit,
  fail,
  json,
  snippetOf,
  toMcpMessage,
} from "./format";
import { registerRoutineTools } from "./routine-tools";
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

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_QUERY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 200;

interface SearchHit {
  author: string;
  authorType: string;
  channelId: string;
  channelName: string;
  createdAt: string;
  id: string;
  replyCount: number;
  snippet: string;
  threadParentId: string | null;
}

/**
 * Hits spend the same output budget an exec's stdout does. A full page of long
 * snippets can outgrow it, and a payload the model has to discard whole is
 * worse than one that stops early and says how much it left behind.
 */
const withinOutputBudget = (
  hits: SearchHit[]
): { dropped: number; kept: SearchHit[] } => {
  const kept: SearchHit[] = [];
  let bytes = 0;
  for (const hit of hits) {
    bytes += new TextEncoder().encode(JSON.stringify(hit)).length;
    if (bytes > TOOL_OUTPUT_MAX_BYTES) {
      break;
    }
    kept.push(hit);
  }
  return { dropped: hits.length - kept.length, kept };
};

const registerSearchMessages = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "search_messages",
    {
      description:
        'Search the messages in your channels for a piece of text, newest first. This is how you find a conversation somebody refers to - "yesterday\'s thread", "the doc we discussed" - instead of paging read_channel until you hit it. Plain substring matching, not semantic, so search for a word that would actually have been typed. Each hit names its channel and its thread: call read_thread with the hit\'s threadParentId to read the conversation around it, or with the hit\'s own id when threadParentId is null and replyCount is above zero.',
      inputSchema: {
        channelId: z
          .string()
          .optional()
          .describe(
            "Search this channel only. Omit to search every channel you are in."
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `Hits to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`
          ),
        query: z
          .string()
          .min(SEARCH_QUERY_MIN_LENGTH)
          .max(SEARCH_QUERY_MAX_LENGTH)
          .describe(
            "The text to look for in message bodies. Case-insensitive, and % and _ are matched literally."
          ),
      },
      title: "Search your messages",
    },
    async ({ channelId, limit, query }) => {
      if (
        channelId &&
        !(await isChannelMember(ctx.db, channelId, memberOf(ctx.agent)))
      ) {
        return fail(NOT_A_MEMBER);
      }

      const hits = await searchMessages(ctx.db, ctx.workspace, {
        channelId,
        limit: clampLimit(limit, {
          fallback: DEFAULT_SEARCH_LIMIT,
          max: MAX_SEARCH_LIMIT,
        }),
        member: memberOf(ctx.agent),
        query,
      });
      if (hits.length === 0) {
        // Nothing matched is an answer, not a failure: the agent should try
        // another word, not conclude the tool is broken.
        return json({
          hits: [],
          note: `No messages in your channels contain "${query}".`,
        });
      }

      const names = await agentNamesById(ctx.db, ctx.workspace.id);
      const { dropped, kept } = withinOutputBudget(
        hits.map(({ channelName, message }) => ({
          author: authorNameOf(message, names),
          authorType: message.authorType,
          channelId: message.channelId,
          channelName,
          createdAt: new Date(message.createdAt).toISOString(),
          id: message.id,
          replyCount: message.replyCount,
          snippet: snippetOf(message.body, query),
          threadParentId: message.threadParentId,
        }))
      );
      if (dropped > 0) {
        return json({
          hits: kept,
          note: `${dropped} more matches were left out to keep this readable. Narrow the query, or pass a channelId.`,
        });
      }
      return json({ hits: kept });
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

// --- questions ---------------------------------------------------------------

const NO_SUCH_QUESTION = (questionId: string) =>
  `No question with id ${questionId}.`;

const registerAskUser = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "ask_user",
    {
      description:
        'Ask the humans a question in a channel and stop. Use it when you genuinely need a decision only they can make - a missing detail, a choice between paths, or permission before anything destructive or irreversible (deleting data, spending money, posting somewhere public): set kind to "permission" for those and do not perform the action until an approving answer arrives. Ask in the channel where the work is happening, so whoever answers has the context. This returns immediately with a questionId and does not wait: end your turn after asking. The answer arrives as a reply in the question\'s thread that wakes you like a mention, and you carry on from there.',
      inputSchema: {
        channelId: z
          .string()
          .describe("The channel to ask in - where the work is happening."),
        expires_in: z
          .string()
          .optional()
          .describe(
            'Optional deadline, e.g. "30m", "2h", "1d". When it passes you are woken with an expiry notice instead of an answer, so you can proceed with your default. Leave it out to wait indefinitely, which is usually right.'
          ),
        kind: z
          .enum(QUESTION_KINDS)
          .optional()
          .describe(
            '"question" for a decision you need, "permission" to ask before doing something risky (defaults to Approve/Deny).'
          ),
        options: z
          .array(z.string())
          .optional()
          .describe(
            "The choices to offer as buttons. Leave it out for a free-text answer."
          ),
        question: z
          .string()
          .max(PROMPT_MAX_LENGTH)
          .describe("What you are asking, in plain words. Markdown."),
      },
      title: "Ask the humans",
    },
    async ({ channelId, expires_in, kind, options, question }) => {
      if (!(await isChannelMember(ctx.db, channelId, memberOf(ctx.agent)))) {
        return fail(NOT_A_MEMBER);
      }
      const expiry = parseExpiresIn(expires_in);
      if (!expiry.ok) {
        return fail(expiry.reason);
      }

      const result = await ask(ctx.db, ctx.env, ctx.workspace, ctx.agent, {
        channelId,
        expiresIn: expiry.seconds,
        kind,
        options,
        prompt: question,
      });
      if (!result.ok) {
        return fail(result.reason);
      }
      if (result.question.expiresAt) {
        // The workspace's timer is what closes an expiry nobody is watching.
        await rescheduleQuestionExpiry(ctx.env, ctx.workspace.id);
      }

      return json({
        expiresAt: result.question.expiresAt?.toISOString() ?? null,
        messageId: result.message.id,
        questionId: result.question.id,
        status: result.question.status,
      });
    }
  );
};

const registerCheckAnswer = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "check_answer",
    {
      description:
        'Look up a question you asked with ask_user. Only for a session that chose to keep working after asking - you do not need to poll, because an answer wakes you by itself. Returns status "pending" while it waits, "answered" with the answer and who gave it, or "expired" when its deadline passed without one.',
      inputSchema: {
        questionId: z.string().describe("The id ask_user gave you."),
      },
      title: "Check a question's answer",
    },
    async ({ questionId }) => {
      // Scoped to this agent's own questions: another agent's id in the same
      // workspace reads exactly like an id that never existed.
      const found = await getQuestionForAgent(
        ctx.db,
        ctx.workspace.id,
        ctx.agent.id,
        questionId
      );
      if (!found) {
        return fail(NO_SUCH_QUESTION(questionId));
      }
      const question = await resolveIfExpired(
        ctx.db,
        ctx.env,
        ctx.workspace,
        found
      );

      const [view] = await toQuestionViews(ctx.db, ctx.workspace.id, [
        question,
      ]);
      const answerer = view ? view.answeredBy : null;
      return json({
        answer: question.answer,
        // A name, never an id: who answered is context for the agent, not
        // something for it to address.
        answeredBy: answerer ? answerer.name : null,
        options: optionsOf(question),
        question: question.prompt,
        status: question.status,
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

// --- model --------------------------------------------------------------------

/** What `set_model` takes to mean "go back to inheriting". */
const CLEAR_MODEL = "default";

const MODEL_LABELS = new Map(
  AVAILABLE_MODELS.map((model) => [model.id as string, model.label as string])
);

type ModelScope =
  | { channelId: string; ok: true; threadParentId: string | null }
  | { ok: false; reason: string };

/**
 * The conversation a model setting is about.
 *
 * The thread id is normalized: an agent naturally passes the id of the message
 * that woke it, which inside a thread is a *reply*. An override keyed on a
 * reply would never be found again - the router resolves by thread parent - so
 * a reply is folded onto the thread it belongs to before anything is written.
 */
const modelScopeOf = async (
  ctx: McpToolContext,
  channelId: string,
  threadParentId: string | undefined
): Promise<ModelScope> => {
  if (!(await isChannelMember(ctx.db, channelId, memberOf(ctx.agent)))) {
    return { ok: false, reason: NOT_A_MEMBER };
  }
  if (threadParentId === undefined) {
    return { channelId, ok: true, threadParentId: null };
  }

  // Workspace-scoped, then checked against the channel: another tenant's
  // message id reads exactly like one that never existed.
  const message = await getMessageInWorkspace(
    ctx.db,
    ctx.workspace.id,
    threadParentId
  );
  if (!message || message.channelId !== channelId) {
    return {
      ok: false,
      reason: `No message with id ${threadParentId} in that channel.`,
    };
  }
  return {
    channelId,
    ok: true,
    threadParentId: message.threadParentId ?? message.id,
  };
};

const MODEL_EFFECT =
  "The change takes effect from your next wake - the turn you are in now finishes on the model it started on, so say so when you confirm it.";

const registerModelTools = (server: McpServer, ctx: McpToolContext): void => {
  server.registerTool(
    "set_model",
    {
      description: `Choose which model you run on in one conversation. When someone says "use opus for this thread", call this with the channelId and threadParentId of the conversation you were woken in; leave threadParentId out to set the model for the whole channel. ${MODEL_EFFECT} Pass "${CLEAR_MODEL}" as the model to clear the override and go back to your configured model. This only ever changes your own model: it says nothing about the other agents in the channel.`,
      inputSchema: {
        channelId: z.string(),
        model: z
          .string()
          .describe(
            `One of: ${AVAILABLE_MODEL_IDS} - or "${CLEAR_MODEL}" to clear the override.`
          ),
        threadParentId: z
          .string()
          .optional()
          .describe(
            "The thread this applies to. Omit to set the model for the whole channel."
          ),
      },
      title: "Set your model for a conversation",
    },
    async ({ channelId, model, threadParentId }) => {
      if (model !== CLEAR_MODEL && !isAvailableModel(model)) {
        return fail(
          `"${model}" is not a model I can run. Use one of: ${AVAILABLE_MODEL_IDS} - or "${CLEAR_MODEL}" to clear the override.`
        );
      }
      const scope = await modelScopeOf(ctx, channelId, threadParentId);
      if (!scope.ok) {
        return fail(scope.reason);
      }

      const target = {
        agentId: ctx.agent.id,
        channelId: scope.channelId,
        threadParentId: scope.threadParentId,
      };
      if (model === CLEAR_MODEL) {
        const cleared = await clearOverride(ctx.db, target);
        const effective = await resolveModelWithSource(ctx.db, target);
        return json({
          appliesFrom: "your next wake",
          cleared,
          model: effective.model,
          scope: scope.threadParentId === null ? "channel" : "thread",
          source: effective.source,
        });
      }

      await upsertOverride(ctx.db, {
        ...target,
        createdBy: `agent:${ctx.agent.id}`,
        model,
        workspaceId: ctx.workspace.id,
      });
      return json({
        appliesFrom: "your next wake",
        label: MODEL_LABELS.get(model) ?? model,
        model,
        scope: scope.threadParentId === null ? "channel" : "thread",
        threadParentId: scope.threadParentId,
      });
    }
  );

  server.registerTool(
    "get_model",
    {
      description:
        "Which model you are running on in a conversation, and where that came from: a thread override, a channel override, your own configuration, or the workspace default. Pass threadParentId to ask about a thread rather than the channel.",
      inputSchema: {
        channelId: z.string(),
        threadParentId: z
          .string()
          .optional()
          .describe("The thread to ask about. Omit to ask about the channel."),
      },
      title: "Check your model for a conversation",
    },
    async ({ channelId, threadParentId }) => {
      const scope = await modelScopeOf(ctx, channelId, threadParentId);
      if (!scope.ok) {
        return fail(scope.reason);
      }

      const effective = await resolveModelWithSource(ctx.db, {
        agentId: ctx.agent.id,
        channelId: scope.channelId,
        threadParentId: scope.threadParentId,
      });
      return json({
        label: MODEL_LABELS.get(effective.model) ?? effective.model,
        model: effective.model,
        scope: scope.threadParentId === null ? "channel" : "thread",
        source: effective.source,
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
  registerSearchMessages(server, ctx);
  registerPostMessage(server, ctx);
  registerListAgents(server, ctx);
  registerAskUser(server, ctx);
  registerCheckAnswer(server, ctx);
  registerModelTools(server, ctx);
  registerWikiTools(server, ctx);
  registerRoutineTools(server, ctx);
  registerSkillTools(server, ctx);
  registerComputerFileTools(server, ctx);
  registerComputerExec(server, ctx);
  registerBrowserTools(server, ctx);
};
