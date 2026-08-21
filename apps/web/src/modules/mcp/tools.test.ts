import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDb, type Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";

/**
 * The agent-facing tools, seen from inside two workspaces at once.
 *
 * The interesting failures here are not "wrong row returned" - phase 3 scoped
 * the queries - but the ones that leak through a *difference in behaviour*: a
 * parameter that answers "no such thing" for an id nobody has and something
 * else for an id another tenant has is an existence oracle for the whole
 * deployment, whatever it returns.
 */

// The browser and computer tools reach Durable Objects; neither is called
// here, and the base class only has to exist for the module to load.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { addChannelMembers, createChannel, createMessage, getThread } =
  await import("#/modules/messaging/service");
const { answerQuestion, getQuestion } = await import(
  "#/modules/questions/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerWorkspaceTools } = await import("./tools");
type McpToolContext = import("./tools").McpToolContext;

/**
 * The tools that publish reach the channel room and the router; both are
 * stubbed rather than skipped, so the message a tool posts really goes through
 * `publishMessage`.
 */
const fakeEnv = (): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
  }) as unknown as Env;

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

/**
 * The shipped migrations in memory, behind the same D1 shim the other
 * multi-tenancy suites use - `createMessage` writes through `db.batch`, which
 * the bare bun-sqlite driver does not have.
 */
const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }

  return createDb({
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database);
};

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * `tools.ts` builds its handlers as closures over the context, so the seam is
 * the registration call itself: a server that only remembers what it was
 * handed lets each tool be invoked directly, with no transport in between.
 */
const toolsOf = (ctx: McpToolContext): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();
  registerWorkspaceTools(
    {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    ctx
  );
  return handlers;
};

const payloadOf = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("expected a text block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

interface Tenant {
  agent: Agent;
  channelId: string;
  clerkUserId: string;
  memberId: string;
  messageId: string;
  tools: Map<string, ToolHandler>;
  workspace: { id: string; slug: string };
}

let db: Db;
let alpha: Tenant;
let beta: Tenant;

/**
 * One workspace, one agent, one channel the agent belongs to, one message from
 * a human. Both workspaces get the same agent and channel names: a query that
 * forgot its scope would find the *other* one rather than nothing.
 */
const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { member, workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: name === "Alpha" ? "Ada Lovelace" : "Bob Barker",
    },
  });
  const ref = { id: workspace.id, slug: workspace.slug };

  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "general" });
  await addChannelMembers(db, channel.id, [
    { memberId: agent.id, memberType: "agent" },
    { memberId: clerkUserId, memberType: "user" },
  ]);

  const posted = await createMessage(db, {
    authorId: clerkUserId,
    authorType: "user",
    body: "hello",
    channelId: channel.id,
    workspace: ref,
  });
  if (!posted.ok) {
    throw new Error("Could not seed the message.");
  }

  return {
    agent,
    channelId: channel.id,
    clerkUserId,
    memberId: member.id,
    messageId: posted.message.id,
    tools: toolsOf({
      agent,
      db,
      env: fakeEnv(),
      requestUrl: "https://app.example.com/mcp/tok",
      workspace: ref,
    }),
    workspace: ref,
  };
};

const call = (
  tenant: Tenant,
  tool: string,
  input: Record<string, unknown> = {}
): Promise<CallToolResult> => {
  const handler = tenant.tools.get(tool);
  if (!handler) {
    throw new Error(`no such tool: ${tool}`);
  }
  return handler(input);
};

beforeEach(async () => {
  db = migrate();
  alpha = await seed("Alpha", ADA_ID);
  beta = await seed("Beta", BOB_ID);
});

describe("list_channels", () => {
  test("shows only the calling agent's own workspace", async () => {
    const payload = payloadOf(await call(alpha, "list_channels"));
    const channels = payload.channels as { id: string; name: string }[];

    expect(channels.map((channel) => channel.id)).toEqual([alpha.channelId]);
    expect(channels.map((channel) => channel.id)).not.toContain(beta.channelId);
  });
});

describe("list_agents", () => {
  test("names only its own workspace's agents, same-named or not", async () => {
    const payload = payloadOf(await call(alpha, "list_agents"));
    const agents = payload.agents as { id: string; name: string }[];

    expect(agents.map((agent) => agent.id)).toEqual([alpha.agent.id]);
    expect(agents.every((agent) => agent.name === "Researcher")).toBe(true);
  });
});

describe("read_channel", () => {
  test("names the human who wrote, not a generic 'User'", async () => {
    const payload = payloadOf(
      await call(alpha, "read_channel", { channelId: alpha.channelId })
    );
    const [message] = payload.messages as {
      author: { id: string; name: string; type: string };
    }[];
    if (!message) {
      throw new Error("Expected the seeded message.");
    }

    expect(message.author.name).toBe("Ada Lovelace");
    expect(message.author.type).toBe("user");
    // The workspace member id, not the Clerk id agents used to be handed.
    expect(message.author.id).not.toBe(ADA_ID);
    expect(JSON.stringify(payload)).not.toContain(ADA_ID);
  });

  test("beforeId is not an existence oracle for other workspaces", async () => {
    const missing = await call(alpha, "read_channel", {
      beforeId: "00000000-0000-4000-8000-000000000000",
      channelId: alpha.channelId,
    });
    const theirs = await call(alpha, "read_channel", {
      beforeId: beta.messageId,
      channelId: alpha.channelId,
    });

    // Identical in every respect an agent can observe: same failure, same
    // wording bar the id it was given back.
    expect(theirs.isError).toBe(true);
    expect(theirs.isError).toBe(missing.isError);
    expect(textOf(theirs)).toBe(`No message with id ${beta.messageId}.`);
    expect(textOf(missing)).toBe(
      "No message with id 00000000-0000-4000-8000-000000000000."
    );

    // And the caller's own id still pages, so the refusal is scope, not a
    // broken cursor.
    const mine = await call(alpha, "read_channel", {
      beforeId: alpha.messageId,
      channelId: alpha.channelId,
    });
    expect(mine.isError).toBeUndefined();
  });
});

describe("read_thread", () => {
  test("refuses another workspace's message id like an unknown one", async () => {
    const theirs = await call(beta, "read_thread", {
      messageId: alpha.messageId,
    });
    expect(theirs.isError).toBe(true);
    expect(textOf(theirs)).toBe(`No message with id ${alpha.messageId}.`);
  });
});

describe("search_messages", () => {
  interface Hit {
    author: string;
    channelId: string;
    channelName: string;
    id: string;
    replyCount: number;
    snippet: string;
    threadParentId: string | null;
  }

  const post = async (
    tenant: Tenant,
    body: string,
    options: { channelId?: string; threadParentId?: string } = {}
  ): Promise<string> => {
    const result = await createMessage(db, {
      authorId: tenant.clerkUserId,
      authorType: "user",
      body,
      channelId: options.channelId ?? tenant.channelId,
      threadParentId: options.threadParentId,
      workspace: tenant.workspace,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.message.id;
  };

  /** A channel in the tenant's own workspace that the agent is not in. */
  const channelWithoutTheAgent = async (tenant: Tenant): Promise<string> => {
    const channel = await createChannel(db, tenant.workspace.id, {
      name: "leadership",
    });
    await addChannelMembers(db, channel.id, [
      { memberId: tenant.clerkUserId, memberType: "user" },
    ]);
    return channel.id;
  };

  const search = (tenant: Tenant, input: Record<string, unknown>) =>
    call(tenant, "search_messages", input);

  const hitsOf = async (
    tenant: Tenant,
    input: Record<string, unknown>
  ): Promise<Hit[]> => payloadOf(await search(tenant, input)).hits as Hit[];

  test("finds a match in the agent's own channels and names the channel", async () => {
    const id = await post(alpha, "The deploy runbook lives in the wiki.");

    const hits = await hitsOf(alpha, { query: "runbook" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      author: "Ada Lovelace",
      channelId: alpha.channelId,
      channelName: "general",
      id,
      threadParentId: null,
    });
    expect(hits[0]?.snippet).toContain("runbook");
    // The workspace member id at most, never the Clerk id behind it.
    expect(JSON.stringify(hits)).not.toContain(ADA_ID);
  });

  test("a channel in the same workspace the agent is not in stays invisible", async () => {
    const channelId = await channelWithoutTheAgent(alpha);
    await post(alpha, "The runbook nobody showed the agent.", { channelId });
    await post(alpha, "The runbook the agent can see.");

    const hits = await hitsOf(alpha, { query: "runbook" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe(alpha.channelId);

    // And naming it outright is refused in read_channel's exact words, so the
    // filter is a boundary rather than a quirk of the query.
    const denied = await search(alpha, { channelId, query: "runbook" });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toBe(
      textOf(await call(alpha, "read_channel", { channelId }))
    );
  });

  test("another workspace's identical message never surfaces", async () => {
    // Both tenants were seeded with the same "hello" from their own human.
    const hits = await hitsOf(alpha, { query: "hello" });

    expect(hits.map((hit) => hit.id)).toEqual([alpha.messageId]);
    expect(hits.map((hit) => hit.id)).not.toContain(beta.messageId);
    expect(JSON.stringify(hits)).not.toContain(BOB_ID);

    // Reaching for the other tenant's channel by id reads like any other
    // channel the agent is not in.
    const denied = await search(alpha, {
      channelId: beta.channelId,
      query: "hello",
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("not a member of that channel");
  });

  test("% and _ in a query are matched literally", async () => {
    const percent = await post(alpha, "Rollout is 100% done.");
    await post(alpha, "Rollout is 1000 done.");
    const underscore = await post(alpha, "The a_b flag is on.");
    await post(alpha, "The axb flag is on.");

    expect(
      (await hitsOf(alpha, { query: "100%" })).map((hit) => hit.id)
    ).toEqual([percent]);
    expect(
      (await hitsOf(alpha, { query: "a_b" })).map((hit) => hit.id)
    ).toEqual([underscore]);
  });

  test("limit caps the page and a nonsense limit falls back", async () => {
    await post(alpha, "runbook number one");
    await post(alpha, "runbook number two");
    await post(alpha, "runbook number three");

    expect(await hitsOf(alpha, { limit: 1, query: "runbook" })).toHaveLength(1);
    expect(await hitsOf(alpha, { limit: 2, query: "runbook" })).toHaveLength(2);
    expect(await hitsOf(alpha, { limit: 0, query: "runbook" })).toHaveLength(3);
    expect(await hitsOf(alpha, { limit: 5000, query: "runbook" })).toHaveLength(
      3
    );
  });

  test("a hit inside a thread carries the thread to read_thread with", async () => {
    const parent = await post(alpha, "Planning the deployment.");
    const reply = await post(alpha, "The deploy window is at noon.", {
      threadParentId: parent,
    });

    const [hit] = await hitsOf(alpha, { query: "noon" });
    expect(hit).toMatchObject({ id: reply, threadParentId: parent });

    // The jump the description promises actually lands.
    const thread = payloadOf(
      await call(alpha, "read_thread", { messageId: hit?.threadParentId })
    );
    expect((thread.parent as { id: string }).id).toBe(parent);
    expect((thread.replies as { id: string }[]).map((row) => row.id)).toEqual([
      reply,
    ]);

    // And the parent's own hit points at itself, by way of its reply count.
    const [parentHit] = await hitsOf(alpha, { query: "Planning" });
    expect(parentHit).toMatchObject({
      id: parent,
      replyCount: 1,
      threadParentId: null,
    });
  });

  test("no match is an answer rather than an error", async () => {
    const result = await search(alpha, { query: "nothing here says this" });

    expect(result.isError).toBeUndefined();
    const payload = payloadOf(result);
    expect(payload.hits).toEqual([]);
    expect(payload.note).toContain("No messages in your channels contain");
  });
});

describe("ask_user", () => {
  const askIn = async (tenant: Tenant, input: Record<string, unknown> = {}) =>
    payloadOf(
      await call(tenant, "ask_user", {
        channelId: tenant.channelId,
        question: "Ship it on Friday or Monday?",
        ...input,
      })
    );

  test("returns a pending question and posts the card in the channel", async () => {
    const payload = await askIn(alpha, { options: ["Friday", "Monday"] });
    expect(payload.status).toBe("pending");
    expect(payload.expiresAt).toBeNull();

    const stored = await getQuestion(
      db,
      alpha.workspace.id,
      payload.questionId as string
    );
    expect(stored).toMatchObject({
      agentId: alpha.agent.id,
      channelId: alpha.channelId,
      status: "pending",
    });

    // The card is a message the agent authored, and reading the channel back
    // shows it as one.
    const channel = payloadOf(
      await call(alpha, "read_channel", { channelId: alpha.channelId })
    );
    const messages = channel.messages as { body: string; id: string }[];
    const card = messages.find((row) => row.id === payload.messageId);
    expect(card?.body).toBe("Ship it on Friday or Monday?");
  });

  test("refuses a channel the agent is not in, and a nonsense expiry", async () => {
    const theirs = await call(alpha, "ask_user", {
      channelId: beta.channelId,
      question: "trespassing",
    });
    expect(theirs.isError).toBe(true);
    expect(textOf(theirs)).toContain("not a member of that channel");

    const badExpiry = await call(alpha, "ask_user", {
      channelId: alpha.channelId,
      expires_in: "10s",
      question: "too soon",
    });
    expect(badExpiry.isError).toBe(true);
  });

  test("an expiry is stored as a deadline, not as a promise to wait", async () => {
    const payload = await askIn(alpha, { expires_in: "30m" });
    const stored = await getQuestion(
      db,
      alpha.workspace.id,
      payload.questionId as string
    );
    const expiresAt = stored?.expiresAt?.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(expiresAt).toBeLessThan(Date.now() + 31 * 60_000);
  });
});

describe("check_answer", () => {
  test("pending before, answered after - with the answerer's name", async () => {
    const asked = payloadOf(
      await call(alpha, "ask_user", {
        channelId: alpha.channelId,
        options: ["Friday", "Monday"],
        question: "Ship it on Friday or Monday?",
      })
    );
    const questionId = asked.questionId as string;

    const before = payloadOf(await call(alpha, "check_answer", { questionId }));
    expect(before).toMatchObject({
      answer: null,
      answeredBy: null,
      options: ["Friday", "Monday"],
      status: "pending",
    });

    const question = await getQuestion(db, alpha.workspace.id, questionId);
    if (!question) {
      throw new Error("Expected the question row.");
    }
    await answerQuestion(db, fakeEnv(), alpha.workspace, question, {
      answer: "Monday",
      by: {
        authorId: alpha.clerkUserId,
        authorType: "user",
        id: alpha.memberId,
        via: "web",
      },
    });

    const after = payloadOf(await call(alpha, "check_answer", { questionId }));
    expect(after).toMatchObject({
      answer: "Monday",
      answeredBy: "Ada Lovelace",
      status: "answered",
    });
    // A name, and never the Clerk id behind it.
    expect(JSON.stringify(after)).not.toContain(ADA_ID);

    // The answer reached the agent the way a mention does.
    const thread = await getThread(db, alpha.workspace, question.messageId);
    expect(thread?.replies[0]?.body).toBe("@Researcher Answer: Monday");
  });

  test("another agent's question reads exactly like one that never existed", async () => {
    const asked = payloadOf(
      await call(alpha, "ask_user", {
        channelId: alpha.channelId,
        question: "mine",
      })
    );
    const questionId = asked.questionId as string;

    // Another workspace's agent, and an id nobody has: same refusal, same
    // wording bar the id.
    const theirs = await call(beta, "check_answer", { questionId });
    const missing = await call(beta, "check_answer", {
      questionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(theirs.isError).toBe(true);
    expect(theirs.isError).toBe(missing.isError);
    expect(textOf(theirs)).toBe(`No question with id ${questionId}.`);
    expect(textOf(missing)).toBe(
      "No question with id 00000000-0000-4000-8000-000000000000."
    );

    // And a second agent inside the *same* workspace is refused too.
    const sibling = await createAgent(db, alpha.workspace.id, {
      instructions: "",
      name: "Analyst",
      soul: "",
    });
    const siblingTools = toolsOf({
      agent: sibling.agent,
      db,
      env: fakeEnv(),
      requestUrl: "https://app.example.com/mcp/tok",
      workspace: alpha.workspace,
    });
    const nosy = await siblingTools.get("check_answer")?.({ questionId });
    expect(nosy?.isError).toBe(true);
    expect(nosy && textOf(nosy)).toBe(`No question with id ${questionId}.`);
  });
});

/**
 * Regression for the wiki's own LIKE escaping: `searchPages` escaped `%` and
 * `_` with backslashes, but its LIKE carried no ESCAPE clause - SQLite has no
 * default escape character, so any query containing those characters silently
 * matched nothing. Lives here beside the search_messages escaping test, which
 * is where the trap was found; the harness this file builds is the DB seam.
 */
describe("wiki searchPages", () => {
  test("% and _ in a query are matched literally", async () => {
    const wikiDb = migrate();
    const { workspace } = await createWorkspace(wikiDb, {
      name: "Wiki Escaping",
      owner: {
        clerkUserId: "user_2wWikiWWWWWWWWWWWWWWWWWW",
        email: "wiki@example.com",
        imageUrl: null,
        name: "Wiki Owner",
      },
    });
    const { writePage, searchPages } = await import("#/modules/wiki/service");
    const author = {
      id: "user_2wWikiWWWWWWWWWWWWWWWWWW",
      type: "user",
    } as const;
    await writePage(wikiDb, workspace.id, {
      author,
      body: "Rollout is 100% done.",
      title: "Percent",
    });
    await writePage(wikiDb, workspace.id, {
      author,
      body: "Rollout is 1000 done.",
      title: "Decoy Percent",
    });
    await writePage(wikiDb, workspace.id, {
      author,
      body: "The a_b flag is on.",
      title: "Underscore",
    });
    await writePage(wikiDb, workspace.id, {
      author,
      body: "The axb flag is on.",
      title: "Decoy Underscore",
    });

    expect(
      (await searchPages(wikiDb, workspace.id, "100%")).map(
        (page) => page.title
      )
    ).toEqual(["Percent"]);
    expect(
      (await searchPages(wikiDb, workspace.id, "a_b")).map((page) => page.title)
    ).toEqual(["Underscore"]);
  });
});
