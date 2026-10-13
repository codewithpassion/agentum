import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generateConnectorKey } from "#/crypto";
import { createDb } from "#/db/client";

/**
 * `browser_screenshot` on the two runtimes. Playwright is replaced at
 * `browser/session`, so the real client stores the PNG and the row; the router
 * is a binding that records what it was asked to deliver.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const unused = () => Promise.reject(new Error("not used in this test"));
mock.module("#/modules/browser/session", () => ({
  runClick: unused,
  runFill: unused,
  runNavigate: unused,
  runScreenshot: () =>
    Promise.resolve({
      bytes: new Uint8Array([1, 2, 3]),
      raw: {
        links: [],
        text: "",
        title: "Example",
        url: "https://example.com/",
      },
      sessionId: "bs_1",
    }),
  runSnapshot: unused,
}));

const { createAgent } = await import("#/modules/agents/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { registerWorkspaceTools } = await import("./tools");

const migrate = () => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
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

type Handler = () => Promise<CallToolResult>;

const run = async (runtime: "cloudflare" | "managed") => {
  const db = migrate();
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_1",
      email: "a@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    runtime,
    soul: "",
  });

  const delivered: { agentId: string; caption: string; imageUrl: string }[] =
    [];
  const stored: string[] = [];
  const env = {
    AGENT_ROUTER: {
      get: () => ({
        deliverImage: (call: (typeof delivered)[number]) => {
          delivered.push(call);
          return Promise.resolve({ sent: true });
        },
      }),
      idFromName: (name: string) => name,
    },
    ATTACHMENT_LINK_KEY: generateConnectorKey(),
    ATTACHMENTS: {
      put: (key: string) => {
        stored.push(key);
        return Promise.resolve();
      },
    },
    BROWSER: {},
    PUBLIC_APP_URL: "https://app.example.com",
  } as unknown as Env;

  let handler: Handler | undefined;
  registerWorkspaceTools(
    {
      registerTool: (name: string, _config: unknown, fn: Handler) => {
        if (name === "browser_screenshot") {
          handler = fn;
        }
      },
    } as unknown as McpServer,
    {
      agent,
      db,
      env,
      requestUrl: "https://app.example.com/mcp/tok",
      workspace: { id: workspace.id, slug: workspace.slug },
    }
  );
  const result = await handler?.();
  const [block] = result?.content ?? [];
  const payload = JSON.parse(block?.type === "text" ? block.text : "{}") as {
    note?: string;
    url?: string;
  };
  return { delivered, payload, stored };
};

describe("browser_screenshot", () => {
  let managed: Awaited<ReturnType<typeof run>>;
  let cloudflare: Awaited<ReturnType<typeof run>>;

  beforeEach(async () => {
    managed = await run("managed");
    cloudflare = await run("cloudflare");
  });

  test("a managed agent gets the image as the next message", () => {
    expect(managed.delivered).toHaveLength(1);
    expect(managed.delivered[0]?.imageUrl).toContain(
      "https://app.example.com/api/agent-images?"
    );
    expect(managed.delivered[0]?.imageUrl).toContain(
      encodeURIComponent(managed.stored[0] ?? "")
    );
    expect(managed.payload.note).toContain("follows as the next message");
    expect(managed.payload.url).toContain("/browser/screenshots/");
  });

  test("a Cloudflare-runtime agent keeps the link and nothing else", () => {
    expect(cloudflare.delivered).toEqual([]);
    expect(cloudflare.payload.note).toBeUndefined();
    expect(cloudflare.payload.url).toContain("/browser/screenshots/");
  });
});
