import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDb, type Db } from "#/db/client";

/**
 * `list_past_sessions` and `read_past_session`, invoked directly: an agent sees
 * only its own sessions, and a transcript comes back a page at a time.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { recordSessionEnd, recordSessionStart } = await import(
  "#/modules/agents/session-history"
);
const { registerSessionTools } = await import("./session-tools");
type McpToolContext = import("./tools").McpToolContext;
type TranscriptEntry = import("#/modules/anthropic/gateway").TranscriptEntry;

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

const fakeEnv = (): Env => ({}) as unknown as Env;

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

const PAGES: Record<
  string,
  {
    entries: TranscriptEntry[];
    nextCursor: string | null;
  }
> = {
  first: {
    entries: [{ at: "2026-10-01T10:00:00Z", kind: "user", text: "hello" }],
    nextCursor: "second",
  },
  second: {
    entries: [{ at: "2026-10-01T10:01:00Z", kind: "agent", text: "hi" }],
    nextCursor: null,
  },
};

const toolsOf = (ctx: McpToolContext) => {
  const handlers = new Map<string, ToolHandler>();
  const asked: { cursor?: string; sessionId: string }[] = [];
  registerSessionTools(
    {
      registerTool: (name: string, _config: unknown, run: ToolHandler) => {
        handlers.set(name, run);
      },
    } as unknown as McpServer,
    ctx,
    () =>
      Promise.resolve({
        listSessionEvents: (
          sessionId: string,
          options: { cursor?: string }
        ) => {
          asked.push({ cursor: options.cursor, sessionId });
          return Promise.resolve(
            PAGES[options.cursor ?? "first"] ?? {
              entries: [],
              nextCursor: null,
            }
          );
        },
      })
  );
  const tool = (name: string): ToolHandler => {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`${name} was not registered`);
    }
    return handler;
  };
  return { asked, tool };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const parse = (result: CallToolResult) => {
  const [block] = result.content;
  return JSON.parse(block?.type === "text" ? block.text : "{}") as Record<
    string,
    unknown
  >;
};

const seed = async () => {
  const db = migrate();
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
  const { agent: other } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Other",
    soul: "",
  });
  const ctx: McpToolContext = {
    agent,
    db,
    env: fakeEnv(),
    requestUrl: "https://app.example.com/mcp/tok",
    workspace: ref,
  };
  const start = (agentId: string, sessionId: string) =>
    recordSessionStart(db, {
      agentId,
      anthropicSessionId: sessionId,
      workspaceId: ref.id,
    });
  return { ctx, db, other, start, ...toolsOf(ctx) };
};

describe("list_past_sessions", () => {
  test("lists only this agent's sessions, newest first, flagging the current one", async () => {
    const { ctx, db, other, start, tool } = await seed();
    await start(ctx.agent.id, "sesn_1");
    await recordSessionEnd(db, "sesn_1", "reset");
    await tick();
    await start(ctx.agent.id, "sesn_2");
    await start(other.id, "sesn_other");

    const body = parse(await tool("list_past_sessions")({}));

    expect(
      (
        body.sessions as {
          current: boolean;
          endReason: string | null;
          sessionId: string;
        }[]
      ).map((s) => [s.sessionId, s.current, s.endReason])
    ).toEqual([
      ["sesn_2", true, null],
      ["sesn_1", false, "reset"],
    ]);
  });

  test("honours the limit", async () => {
    const { ctx, start, tool } = await seed();
    await start(ctx.agent.id, "sesn_1");
    await tick();
    await start(ctx.agent.id, "sesn_2");

    const body = parse(await tool("list_past_sessions")({ limit: 1 }));

    expect(body.sessions).toHaveLength(1);
  });
});

describe("read_past_session", () => {
  test("pages through the transcript with a cursor", async () => {
    const { asked, ctx, start, tool } = await seed();
    await start(ctx.agent.id, "sesn_1");

    const first = parse(
      await tool("read_past_session")({ session_id: "sesn_1" })
    );
    const second = parse(
      await tool("read_past_session")({
        cursor: first.next_cursor,
        session_id: "sesn_1",
      })
    );

    expect(first.next_cursor).toBe("second");
    expect(first.entries).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(asked.map((a) => a.cursor)).toEqual([undefined, "second"]);
  });

  test("refuses another agent's session without asking Anthropic", async () => {
    const { asked, other, start, tool } = await seed();
    await start(other.id, "sesn_other");

    const result = await tool("read_past_session")({
      session_id: "sesn_other",
    });

    expect(result.isError).toBe(true);
    expect(asked).toEqual([]);
  });

  test("refuses a session id it has never heard of", async () => {
    const { asked, tool } = await seed();

    const result = await tool("read_past_session")({ session_id: "sesn_nope" });

    expect(result.isError).toBe(true);
    expect(asked).toEqual([]);
  });
});
