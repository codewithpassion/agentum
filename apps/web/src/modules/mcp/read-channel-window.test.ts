import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "#/db/client";

/**
 * `read_channel` starts at the agent's latest session divider, marks it, and
 * only reads past it when asked.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { addChannelMembers, createChannel, createMessage } = await import(
  "#/modules/messaging/service"
);
const { postSessionDivider } = await import(
  "#/modules/messaging/session-divider"
);
const { messages: messagesTable } = await import("#/modules/messaging/schema");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerWorkspaceTools } = await import("./tools");
type McpToolContext = import("./tools").McpToolContext;

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BASE_MS = Date.UTC(2026, 9, 1);
const STEP_MS = 60_000;

const migrate = (): { d1: D1Database; db: Db } => {
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
  const d1 = {
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
  } as unknown as D1Database;
  return { d1, db: createDb(d1) };
};

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

const readChannelOf = (ctx: McpToolContext): ToolHandler => {
  const handlers = new Map<string, ToolHandler>();
  registerWorkspaceTools(
    {
      registerTool: (toolName: string, _config: unknown, fn: ToolHandler) => {
        handlers.set(toolName, fn);
      },
    } as unknown as McpServer,
    ctx
  );
  const handler = handlers.get("read_channel");
  if (!handler) {
    throw new Error("read_channel is not registered");
  }
  return handler;
};

const read = async (
  handler: ToolHandler,
  input: Record<string, unknown>
): Promise<{
  hasMore: boolean;
  messages: { body: string }[];
  note?: string;
}> => {
  const [block] = (await handler(input)).content;
  if (block?.type !== "text") {
    throw new Error("expected a text block");
  }
  return JSON.parse(block.text);
};

let tool: ToolHandler;
let channelId: string;
let firstAfterId: string;
let dividerIdOf: string;

beforeEach(async () => {
  const { d1, db } = migrate();
  const env = {
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  } as unknown as Env;
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "ops" });
  channelId = channel.id;
  await addChannelMembers(db, channelId, [
    { memberId: ADA_ID, memberType: "user" },
    { memberId: agent.id, memberType: "agent" },
  ]);

  const ref = { id: workspace.id, slug: workspace.slug };
  // Rows get whole-second timestamps by default; pin distinct ones so the
  // order does not depend on random ids.
  let step = 0;
  const pin = async (id: string) => {
    step += 1;
    await db
      .update(messagesTable)
      .set({ createdAt: new Date(BASE_MS + step * STEP_MS) })
      .where(eq(messagesTable.id, id));
  };
  const say = async (body: string) => {
    const result = await createMessage(db, {
      authorId: ADA_ID,
      authorType: "user",
      body,
      channelId,
      workspace: ref,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    await pin(result.message.id);
    return result.message.id;
  };
  await say("old one");
  await say("old two");
  const divider = await postSessionDivider(db, env, {
    agent,
    channelId,
    workspaceId: workspace.id,
  });
  if (!divider) {
    throw new Error("no divider");
  }
  await pin(divider.id);
  dividerIdOf = divider.id;
  firstAfterId = await say("fresh one");
  await say("fresh two");

  tool = readChannelOf({
    agent,
    db,
    env,
    requestUrl: "https://example.test/mcp",
    workspace: ref,
  });
});

describe("read_channel and session dividers", () => {
  test("defaults to the messages since the agent's latest divider, marked", async () => {
    const result = await read(tool, { channelId });

    expect(result.messages.map((message) => message.body)).toEqual([
      "[session start] New session started for Researcher.",
      "fresh one",
      "fresh two",
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.note).toContain("includeEarlier");
  });

  test("includeEarlier reads past the divider, still marked", async () => {
    const result = await read(tool, { channelId, includeEarlier: true });

    expect(result.messages.map((message) => message.body)).toEqual([
      "old one",
      "old two",
      "[session start] New session started for Researcher.",
      "fresh one",
      "fresh two",
    ]);
    expect(result.note).toBeUndefined();
  });

  test("paging back from the divider returns nothing unless asked", async () => {
    const fresh = await read(tool, { channelId });
    expect(fresh.messages).toHaveLength(3);

    // From "fresh one" back: only the divider is left in the window.
    const atDivider = await read(tool, { beforeId: firstAfterId, channelId });
    expect(atDivider.messages.map((message) => message.body)).toEqual([
      "[session start] New session started for Researcher.",
    ]);

    // Paging from the divider itself would go to the old session: refused.
    const dividerId = dividerIdOf;
    const past = await read(tool, { beforeId: dividerId, channelId });
    expect(past.messages).toEqual([]);
    expect(past.note).toContain("includeEarlier");

    const allowed = await read(tool, {
      beforeId: dividerId,
      channelId,
      includeEarlier: true,
    });
    expect(allowed.messages.map((message) => message.body)).toEqual([
      "old one",
      "old two",
    ]);
  });
});
