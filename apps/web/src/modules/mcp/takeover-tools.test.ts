import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "#/db/client";

/**
 * `request_human_takeover`, invoked directly. The tool posts the takeover card
 * and its row, refuses a second request while one waits, and its row expires
 * through the workspace's existing sweep.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { messages } = await import("#/modules/messaging/schema");
const { addChannelMembers, createChannel } = await import(
  "#/modules/messaging/service"
);
const { getQuestion, sweepExpiredQuestions } = await import(
  "#/modules/questions/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerTakeoverTools } = await import("./takeover-tools");
type McpToolContext = import("./tools").McpToolContext;

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const migrate = (): Db => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
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

const toolOf = (ctx: McpToolContext): ToolHandler => {
  let handler: ToolHandler | undefined;
  registerTakeoverTools(
    {
      registerTool: (_name: string, _config: unknown, run: ToolHandler) => {
        handler = run;
      },
    } as unknown as McpServer,
    ctx
  );
  if (!handler) {
    throw new Error("request_human_takeover was not registered");
  }
  return handler;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

const seed = async () => {
  const db = migrate();
  const env = fakeEnv();
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_owner",
      email: "owner@example.com",
      imageUrl: null,
      name: "Owner",
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
  ]);
  const ctx: McpToolContext = {
    agent,
    db,
    env,
    requestUrl: "https://app.example.com/mcp/tok",
    workspace: ref,
  };
  return {
    channelId: channel.id,
    ctx,
    db,
    tool: toolOf(ctx),
    workspaceId: ref.id,
  };
};

describe("request_human_takeover", () => {
  test("posts a takeover card and its row, and tells the agent to end its turn", async () => {
    const { channelId, db, tool, workspaceId } = await seed();

    const result = await tool({
      channelId,
      reason: "Solve the CAPTCHA on the login page",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as {
      note: string;
      takeoverId: string;
    };
    expect(payload.note).toContain("End your turn now");
    const row = await getQuestion(db, workspaceId, payload.takeoverId);
    expect(row).toMatchObject({
      kind: "takeover",
      options: null,
      prompt: "Solve the CAPTCHA on the login page",
      status: "pending",
    });
    const [posted] = await db
      .select({ origin: messages.origin })
      .from(messages)
      .where(eq(messages.id, row?.messageId ?? ""));
    expect(posted?.origin).toBe("takeover");
  });

  test("refuses a second request while one is still pending", async () => {
    const { channelId, tool } = await seed();
    await tool({ channelId, reason: "First: log in" });

    const second = await tool({ channelId, reason: "Second: approve a code" });

    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("already pending");
  });

  test("a request that ran out of time is swept, and the agent is woken with an expiry notice", async () => {
    const { channelId, ctx, db, tool, workspaceId } = await seed();
    const result = await tool({ channelId, reason: "Log in for me" });
    const payload = JSON.parse(textOf(result)) as { takeoverId: string };

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const expired = await sweepExpiredQuestions(
      db,
      ctx.env,
      ctx.workspace,
      later
    );

    expect(expired.map((row) => row.id)).toEqual([payload.takeoverId]);
    const settled = await getQuestion(db, workspaceId, payload.takeoverId);
    expect(settled?.status).toBe("expired");
    const notices = await db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.channelId, channelId));
    expect(
      notices.some((notice) => notice.body.includes("nobody took over"))
    ).toBe(true);
  });
});
