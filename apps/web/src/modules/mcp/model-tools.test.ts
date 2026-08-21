import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDb, type Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";

/**
 * `set_model` and `get_model`, which are the whole of the per-conversation
 * model feature as an agent experiences it.
 *
 * Two things are being pinned down. The first is precedence: what `get_model`
 * says is the same ladder the router climbs at wake, reported with the rung it
 * stopped on. The second is reach - an agent sets its *own* model in a channel
 * it is in, and nothing it passes can make it touch another agent's setting or
 * confirm that another tenant's channel exists.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { resolveModel } = await import("#/modules/agents/model-overrides");
const { addChannelMembers, createChannel, createMessage } = await import(
  "#/modules/messaging/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerWorkspaceTools } = await import("./tools");
type McpToolContext = import("./tools").McpToolContext;

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";
const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";

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

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

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
  /** A second channel the agent is in, for "that thread is not here" cases. */
  otherChannelId: string;
  /** A top-level message in `channelId`, and a reply under it. */
  replyId: string;
  threadId: string;
  tools: Map<string, ToolHandler>;
  workspace: { id: string; slug: string };
}

let db: Db;
let alpha: Tenant;
let beta: Tenant;

const post = async (
  ref: { id: string; slug: string },
  input: { authorId: string; channelId: string; threadParentId?: string }
): Promise<string> => {
  const result = await createMessage(db, {
    authorId: input.authorId,
    authorType: "user",
    body: "hello",
    channelId: input.channelId,
    threadParentId: input.threadParentId,
    workspace: ref,
  });
  if (!result.ok) {
    throw new Error("Could not seed the message.");
  }
  return result.message.id;
};

const contextFor = (
  agent: Agent,
  workspace: { id: string; slug: string }
): McpToolContext => ({
  agent,
  db,
  env: fakeEnv(),
  requestUrl: "https://app.example.com/mcp/tok",
  workspace,
});

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name,
    },
  });
  const ref = { id: workspace.id, slug: workspace.slug };

  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "general" });
  const other = await createChannel(db, workspace.id, { name: "random" });
  for (const room of [channel, other]) {
    // biome-ignore lint/performance/noAwaitInLoops: two rooms, in order
    await addChannelMembers(db, room.id, [
      { memberId: agent.id, memberType: "agent" },
      { memberId: clerkUserId, memberType: "user" },
    ]);
  }

  const threadId = await post(ref, {
    authorId: clerkUserId,
    channelId: channel.id,
  });
  const replyId = await post(ref, {
    authorId: clerkUserId,
    channelId: channel.id,
    threadParentId: threadId,
  });

  return {
    agent,
    channelId: channel.id,
    otherChannelId: other.id,
    replyId,
    threadId,
    tools: toolsOf(contextFor(agent, ref)),
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
    throw new Error(`no tool called ${tool}`);
  }
  return handler(input);
};

beforeEach(async () => {
  db = migrate();
  alpha = await seed("Alpha", ADA_ID);
  beta = await seed("Beta", BOB_ID);
});

describe("get_model", () => {
  test("falls back to the workspace default with nothing set", async () => {
    const result = await call(alpha, "get_model", {
      channelId: alpha.channelId,
    });

    expect(payloadOf(result)).toMatchObject({
      model: SONNET,
      source: "workspace default",
    });
  });

  test("names the agent's own model when it has one", async () => {
    const { updateAgent } = await import("#/modules/agents/service");
    await updateAgent(db, alpha.workspace.id, alpha.agent.id, { model: HAIKU });

    const result = await call(alpha, "get_model", {
      channelId: alpha.channelId,
    });

    expect(payloadOf(result)).toMatchObject({
      model: HAIKU,
      source: "agent config",
    });
  });

  test("a thread inherits the channel's override and says where it came from", async () => {
    await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: HAIKU,
    });

    const result = await call(alpha, "get_model", {
      channelId: alpha.channelId,
      threadParentId: alpha.threadId,
    });

    expect(payloadOf(result)).toMatchObject({
      model: HAIKU,
      scope: "thread",
      source: "channel override",
    });
  });

  test("a thread override beats the channel's", async () => {
    await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: HAIKU,
    });
    await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
      threadParentId: alpha.threadId,
    });

    const thread = await call(alpha, "get_model", {
      channelId: alpha.channelId,
      threadParentId: alpha.threadId,
    });
    const channel = await call(alpha, "get_model", {
      channelId: alpha.channelId,
    });

    expect(payloadOf(thread)).toMatchObject({
      model: OPUS,
      source: "thread override",
    });
    expect(payloadOf(channel)).toMatchObject({
      model: HAIKU,
      source: "channel override",
    });
  });
});

describe("set_model", () => {
  test("writes an override the router's resolver finds", async () => {
    const result = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
      threadParentId: alpha.threadId,
    });

    expect(payloadOf(result)).toMatchObject({
      appliesFrom: "your next wake",
      label: "Opus 5",
      model: OPUS,
      scope: "thread",
    });
    expect(
      await resolveModel(db, {
        agentId: alpha.agent.id,
        channelId: alpha.channelId,
        threadParentId: alpha.threadId,
      })
    ).toBe(OPUS);
  });

  test("the id of a reply sets the model for the thread it is in", async () => {
    // An agent woken inside a thread naturally passes the message that woke it,
    // which is a reply; an override keyed on that id would never be read again.
    const result = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
      threadParentId: alpha.replyId,
    });

    expect(payloadOf(result)).toMatchObject({ threadParentId: alpha.threadId });
    expect(
      await resolveModel(db, {
        agentId: alpha.agent.id,
        channelId: alpha.channelId,
        threadParentId: alpha.threadId,
      })
    ).toBe(OPUS);
  });

  test('"default" clears the override and reports what it fell back to', async () => {
    await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
    });

    const cleared = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: "default",
    });

    expect(payloadOf(cleared)).toMatchObject({
      cleared: true,
      model: SONNET,
      source: "workspace default",
    });
    expect(
      await resolveModel(db, {
        agentId: alpha.agent.id,
        channelId: alpha.channelId,
      })
    ).toBe(SONNET);
  });

  test("clearing an override that was never there is not an error", async () => {
    const result = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: "default",
    });

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({ cleared: false });
  });

  test("refuses a model the deployment does not offer, naming the ones it does", async () => {
    const result = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: "gpt-9",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(OPUS);
    expect(textOf(result)).toContain(HAIKU);
    // Nothing was written on the way to the refusal.
    expect(
      await resolveModel(db, {
        agentId: alpha.agent.id,
        channelId: alpha.channelId,
      })
    ).toBe(SONNET);
  });

  test("refuses another workspace's channel", async () => {
    const result = await call(alpha, "set_model", {
      channelId: beta.channelId,
      model: OPUS,
    });

    expect(result.isError).toBe(true);
    expect(
      await resolveModel(db, {
        agentId: alpha.agent.id,
        channelId: beta.channelId,
      })
    ).toBe(SONNET);
  });

  test("refuses a thread that is not in the channel it was given", async () => {
    const result = await call(alpha, "set_model", {
      channelId: alpha.otherChannelId,
      model: OPUS,
      threadParentId: alpha.threadId,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(alpha.threadId);
  });

  test("another tenant's message id reads like one that never existed", async () => {
    const foreign = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
      threadParentId: beta.threadId,
    });
    const invented = await call(alpha, "set_model", {
      channelId: alpha.channelId,
      model: OPUS,
      threadParentId: "msg_nobody_has",
    });

    expect(textOf(foreign)).toBe(
      textOf(invented).replace("msg_nobody_has", beta.threadId)
    );
  });

  test("sets only its own model, not another agent's in the same channel", async () => {
    const { agent: other } = await createAgent(db, alpha.workspace.id, {
      instructions: "",
      name: "Scribe",
      soul: "",
    });
    const { addChannelMember } = await import("#/modules/messaging/service");
    await addChannelMember(db, alpha.channelId, {
      memberId: other.id,
      memberType: "agent",
    });

    await call(alpha, "set_model", { channelId: alpha.channelId, model: OPUS });

    expect(
      await resolveModel(db, {
        agentId: other.id,
        channelId: alpha.channelId,
      })
    ).toBe(SONNET);
  });
});
