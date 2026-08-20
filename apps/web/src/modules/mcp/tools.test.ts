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
const { addChannelMembers, createChannel, createMessage } = await import(
  "#/modules/messaging/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerWorkspaceTools } = await import("./tools");
type McpToolContext = import("./tools").McpToolContext;

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
  messageId: string;
  tools: Map<string, ToolHandler>;
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
  const { workspace } = await createWorkspace(db, {
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
    messageId: posted.message.id,
    tools: toolsOf({
      agent,
      db,
      env: {} as unknown as Env,
      requestUrl: "https://app.example.com/mcp/tok",
      workspace: ref,
    }),
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
