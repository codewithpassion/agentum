import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generateConnectorKey } from "#/crypto";
import { createDb, type Db } from "#/db/client";
import { listActivity } from "#/modules/activity/service";

/**
 * `attachment_link` from the agent's side.
 *
 * Two things are load-bearing. An agent may only link a file its own workspace
 * can see - after that the signature is the credential and nobody re-checks the
 * tenant - and every mint leaves an activity row, because handing out one of
 * these URLs publishes a private file to whoever holds it and that is precisely
 * what an owner needs to be able to find afterwards.
 */

// The router and the computer tools reach Durable Objects; none is called here,
// and the base class only has to exist for the modules to load.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { DEFAULT_LINK_TTL_SECONDS, MAX_LINK_TTL_SECONDS, verifyAttachmentLink } =
  await import("#/modules/messaging/attachment-links");
const { attachments, channels, messages } = await import(
  "#/modules/messaging/schema"
);
const { registerAttachmentTools } = await import("./attachment-tools");
type McpToolContext = import("./tools").McpToolContext;

const KEY = generateConnectorKey();
const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";
const NO_SUCH = /No attachment with id/;
const NOT_CONFIGURED = /ATTACHMENT_LINK_KEY is not configured/;
/** The id differs between the two misses; the rest of the sentence must not. */
const THE_ID = /id \S+/;

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
  return createDb(d1);
};

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

/** The registration call is the seam, as in `secret-tools.test.ts`. */
const toolsOf = (ctx: McpToolContext): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();
  registerAttachmentTools(
    {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    ctx
  );
  return handlers;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

const payloadOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

interface Tenant {
  agentId: string;
  attachmentId: string;
  ctx: McpToolContext;
  link: ToolHandler;
}

let db: Db;
let env: Env;
let alpha: Tenant;
let beta: Tenant;
/** Uploaded but never posted, so no message and no channel scope it. */
let unclaimedId: string;

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: `Owner of ${name}`,
    },
  });
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: `Agent of ${name}`,
    soul: "",
  });

  const channelId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  await db
    .insert(channels)
    .values({ id: channelId, name: "general", workspaceId: workspace.id });
  await db.insert(messages).values({
    authorId: agent.id,
    authorType: "agent",
    body: "the recording",
    channelId,
    id: messageId,
  });
  await db.insert(attachments).values({
    filename: "standup.mp3",
    id: attachmentId,
    messageId,
    mime: "audio/mpeg",
    r2Key: `attachments/${attachmentId}`,
    size: 4096,
  });

  const ctx: McpToolContext = {
    agent,
    db,
    env,
    requestUrl: "https://mcp.internal.example/mcp/tok",
    workspace: { id: workspace.id, slug: workspace.slug },
  };
  const tools = toolsOf(ctx);
  const link = tools.get("attachment_link");
  if (!link) {
    throw new Error("attachment_link was not registered");
  }
  return { agentId: agent.id, attachmentId, ctx, link };
};

beforeEach(async () => {
  db = migrate();
  env = {
    ATTACHMENT_LINK_KEY: KEY,
    PUBLIC_APP_URL: "https://app.example.com",
  } as unknown as Env;
  alpha = await seed("Alpha", ADA_ID);
  beta = await seed("Beta", BOB_ID);

  unclaimedId = crypto.randomUUID();
  await db.insert(attachments).values({
    filename: "draft.txt",
    id: unclaimedId,
    mime: "text/plain",
    r2Key: `attachments/${unclaimedId}`,
    size: 12,
  });
});

const rowsFor = async (agentId: string) =>
  (await listActivity(db, { agentId, limit: 10 })).entries;

describe("minting", () => {
  test("hands back an absolute URL whose signature verifies", async () => {
    const payload = payloadOf(
      await alpha.link({ attachmentId: alpha.attachmentId })
    );
    const url = new URL(String(payload.url));

    // PUBLIC_APP_URL, not the origin the MCP call arrived on: the fetcher is a
    // service on the internet, and on the Cloudflare runtime the MCP server is
    // connected in memory with no public origin at all.
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe(`/api/attachment-links/${alpha.attachmentId}`);
    expect(
      await verifyAttachmentLink(KEY, {
        exp: url.searchParams.get("exp"),
        id: alpha.attachmentId,
        sig: url.searchParams.get("sig"),
      })
    ).toBe(true);
  });

  test("returns what the agent needs to decide and to call", async () => {
    const payload = payloadOf(
      await alpha.link({ attachmentId: alpha.attachmentId })
    );

    expect(payload.filename).toBe("standup.mp3");
    expect(payload.mime).toBe("audio/mpeg");
    expect(payload.size).toBe(4096);
    // An expiry it can read, so it knows how long it has.
    const seconds = (Date.parse(String(payload.expiresAt)) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(DEFAULT_LINK_TTL_SECONDS - 60);
    expect(seconds).toBeLessThanOrEqual(DEFAULT_LINK_TTL_SECONDS);
  });

  test("an over-long ttl is capped rather than refused", async () => {
    const payload = payloadOf(
      await alpha.link({ attachmentId: alpha.attachmentId, ttlSeconds: 86_400 })
    );

    const seconds = (Date.parse(String(payload.expiresAt)) - Date.now()) / 1000;
    expect(seconds).toBeLessThanOrEqual(MAX_LINK_TTL_SECONDS);
    expect(seconds).toBeGreaterThan(MAX_LINK_TTL_SECONDS - 60);
  });

  test("records the mint, and never the signature", async () => {
    const payload = payloadOf(
      await alpha.link({ attachmentId: alpha.attachmentId })
    );
    const [row] = await rowsFor(alpha.agentId);

    expect(row?.kind).toBe("attachment.link");
    expect(row?.summary).toContain("standup.mp3");
    expect(row?.detail?.attachmentId).toBe(alpha.attachmentId);
    expect(row?.detail?.expiresAt).toBe(payload.expiresAt);
    // The row is an audit trail, not a second copy of the credential.
    expect(JSON.stringify(row)).not.toContain(
      new URL(String(payload.url)).searchParams.get("sig") ?? "?"
    );
  });
});

describe("what an agent may not link", () => {
  test("another workspace's attachment", async () => {
    const result = await alpha.link({ attachmentId: beta.attachmentId });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(NO_SUCH);
    // And nothing was minted, so there is nothing to audit.
    expect(await rowsFor(alpha.agentId)).toHaveLength(0);
  });

  test("an id that does not exist, in the same words", async () => {
    const missing = await alpha.link({ attachmentId: crypto.randomUUID() });
    const other = await alpha.link({ attachmentId: beta.attachmentId });

    // One sentence for both: telling them apart would let an agent enumerate
    // attachment ids across the deployment.
    expect(textOf(missing).replace(THE_ID, "id X")).toBe(
      textOf(other).replace(THE_ID, "id X")
    );
  });

  test("an unclaimed upload is linkable, as the authenticated route allows", async () => {
    // `getAttachmentInWorkspace` accepts an attachment no message has claimed:
    // there is no parent to scope it through, and its id is an unguessable UUID.
    // Worth knowing, since it means a not-yet-posted upload is not tenant-scoped.
    const result = await alpha.link({ attachmentId: unclaimedId });

    expect(result.isError).toBeUndefined();
  });
});

describe("with no key configured", () => {
  test("refuses to mint, says which variable to set, and audits nothing", async () => {
    const ctx: McpToolContext = {
      ...alpha.ctx,
      env: { ...env, ATTACHMENT_LINK_KEY: "" } as unknown as Env,
    };
    const link = toolsOf(ctx).get("attachment_link");
    const result = await link?.({ attachmentId: alpha.attachmentId });

    expect(result?.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toMatch(NOT_CONFIGURED);
    // Nothing was published, so nothing is recorded as published.
    expect(await rowsFor(alpha.agentId)).toHaveLength(0);
  });
});
