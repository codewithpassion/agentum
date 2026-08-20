import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The per-app events endpoint, end to end: two connected agents, each with its
 * own signing secret, against the shipped migrations in an in-memory database
 * and a faked Slack API.
 *
 * What it pins down: a signature is only ever checked against the app the URL
 * names, a draft may answer the handshake and nothing else, an event is only
 * acted on by the app that owns the bridge, and a reply goes back out through
 * that app's own bot token.
 */

// `publishMessage` reaches the channel and router Durable Objects, which import
// a module only the Workers runtime provides.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { generateConnectorKey } = await import("#/crypto");
const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { publishMessage } = await import("#/modules/messaging/publish");
const { createChannel, listChannelMessages } = await import(
  "#/modules/messaging/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { upsertBridge } = await import("../bridges");
const { createDraftSlackApp, storeSlackAppTokens } = await import("./apps");
const { slackRoutes } = await import("./routes");
const { signSlackRequest } = await import("./signature");

const KEY = generateConnectorKey();
const MILLISECONDS = 1000;
const ADA_CHANNEL = "C0ADACHAN";
const ADA_TOKEN = "xoxb-ada-token";
const ADA_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BOB_TOKEN = "xoxb-bob-token";
const BOB_SECRET = "0000000000000000000000000000bbbb";

const migrationsDir = new URL("../../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
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

  return {
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
};

interface SlackCall {
  method: string;
  payload: Record<string, unknown>;
  token: string;
}

let slackCalls: SlackCall[];

/**
 * Slack's Web API, narrowed to what these paths touch. The bearer token is
 * recorded with every call: "which bot posted this" is the whole question the
 * mirror cases ask.
 */
const fakeSlackFetch = ((
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input.toString());
  const method = url.split("/api/")[1]?.split("?")[0] ?? "";
  const headers = new Headers(init?.headers);
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  slackCalls.push({
    method,
    payload: body,
    token: (headers.get("authorization") ?? "").replace("Bearer ", ""),
  });

  const answers: Record<string, unknown> = {
    "auth.test": {
      ok: true,
      team: "Rocky Shores",
      team_id: "T0RSL",
      user_id: "U0BOT",
    },
    "chat.postMessage": { ok: true, ts: "1787200000.000900" },
    "users.info": {
      ok: true,
      user: { profile: { display_name: "Ada Lovelace" } },
    },
  };
  return Promise.resolve(Response.json(answers[method] ?? { ok: true }));
}) as unknown as typeof fetch;

let d1: D1Database;
let db: Db;
let env: Env;
let pending: Promise<unknown>[];
let workspace: { id: string; slug: string };
let adaId: string;
let bobId: string;
let adaAppId: string;
let bobAppId: string;
let draftAppId: string;
let channelId: string;

const executionCtx = {
  passThroughOnException: () => {
    // Nothing to pass through: the fake environment has no origin behind it.
  },
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
} as unknown as ExecutionContext;

const settle = async () => {
  await Promise.all(pending);
  pending = [];
};

const post = async (
  appId: string,
  body: unknown,
  options: { signWith?: string | null; timestamp?: string } = {}
): Promise<Response> => {
  const rawBody = JSON.stringify(body);
  const timestamp =
    options.timestamp ?? String(Math.floor(Date.now() / MILLISECONDS));
  const secret = options.signWith === undefined ? ADA_SECRET : options.signWith;

  return await slackRoutes.request(
    `/${appId}`,
    {
      body: rawBody,
      headers: {
        "content-type": "application/json",
        ...(secret
          ? {
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": await signSlackRequest(
                secret,
                timestamp,
                rawBody
              ),
            }
          : {}),
      },
      method: "POST",
    },
    env,
    executionCtx
  );
};

const messageEvent = (channel: string, ts: string, text = "hello there") => ({
  authorizations: [{ user_id: "U0BOT" }],
  event: { channel, text, ts, type: "message", user: "U1HUMAN" },
  event_id: `Ev${ts}`,
  team_id: "T0RSL",
  type: "event_callback",
});

const channelMessages = async () =>
  (
    await listChannelMessages(db, workspace, {
      channelId,
      limit: 50,
    })
  ).messages;

const connect = async (
  agentId: string,
  token: string,
  signingSecret: string
): Promise<string> => {
  const draft = await createDraftSlackApp(db, workspace.id, agentId);
  const result = await storeSlackAppTokens(
    db,
    KEY,
    draft,
    { botToken: token, signingSecret },
    fakeSlackFetch
  );
  return result.app.id;
};

beforeEach(async () => {
  slackCalls = [];
  pending = [];
  globalThis.fetch = fakeSlackFetch;

  d1 = createTestD1();
  db = createDb(d1);
  env = {
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CONNECTOR_KEY: KEY,
    DB: d1,
  } as unknown as Env;

  const created = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_ada",
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  workspace = { id: created.workspace.id, slug: created.workspace.slug };

  const ada = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  adaId = ada.agent.id;
  const bob = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Bob",
    soul: "",
  });
  bobId = bob.agent.id;
  const carol = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Carol",
    soul: "",
  });

  adaAppId = await connect(adaId, ADA_TOKEN, ADA_SECRET);
  bobAppId = await connect(bobId, BOB_TOKEN, BOB_SECRET);
  draftAppId = (await createDraftSlackApp(db, workspace.id, carol.agent.id)).id;

  const channel = await createChannel(db, workspace.id, { name: "ops" });
  channelId = channel.id;
  await upsertBridge(db, workspace.id, {
    agentId: adaId,
    channelId,
    connector: "slack",
    externalChannelId: ADA_CHANNEL,
    slackAppId: adaAppId,
  });
  slackCalls = [];
});

describe("the app the URL names", () => {
  test("an unknown id is refused, so a stale events URL fails loudly", async () => {
    const response = await post("00000000-0000-4000-8000-000000000000", {
      challenge: "3eZbrw1aB",
      type: "url_verification",
    });

    expect(response.status).toBe(404);
  });

  test("a signature made with another app's secret is invalid here", async () => {
    const response = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.1"), {
      signWith: BOB_SECRET,
    });

    expect(response.status).toBe(401);
    expect(await channelMessages()).toHaveLength(0);
  });

  test("each app's own secret verifies against its own URL", async () => {
    const ada = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.2"));
    const bob = await post(bobAppId, messageEvent("C0BOBCHAN", "1.3"), {
      signWith: BOB_SECRET,
    });

    expect([ada.status, bob.status]).toEqual([200, 200]);
  });

  test("refuses an unsigned and a replayed request", async () => {
    const unsigned = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.4"), {
      signWith: null,
    });
    const stale = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.5"), {
      timestamp: String(Math.floor(Date.now() / MILLISECONDS) - 60 * 10),
    });

    expect([unsigned.status, stale.status]).toEqual([401, 401]);
  });
});

describe("a draft app", () => {
  test("answers the url_verification handshake unsigned", async () => {
    // Slack verifies the request URL the moment the app is created from the
    // manifest - before anyone could have pasted us a signing secret.
    const response = await post(
      draftAppId,
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { signWith: null }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({
      challenge: "3eZbrw1aB",
    });
  });

  test("refuses every other event while it has no secret", async () => {
    const response = await post(draftAppId, messageEvent(ADA_CHANNEL, "1.6"), {
      signWith: null,
    });

    expect(response.status).toBe(401);
    expect(await channelMessages()).toHaveLength(0);
  });
});

describe("the ownership filter", () => {
  test("an event for an app that does not own the bridge is dropped", async () => {
    // Both bots sit in `ADA_CHANNEL`, so both are delivered its messages. Only
    // the one the bridge belongs to may act on it.
    const response = await post(bobAppId, messageEvent(ADA_CHANNEL, "1.7"), {
      signWith: BOB_SECRET,
    });
    await settle();

    expect(response.status).toBe(200);
    expect(await channelMessages()).toHaveLength(0);
  });
});

describe("a verified event, end to end", () => {
  test("is ingested, and the reply goes out through that app's own bot", async () => {
    const response = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.8"));
    await settle();

    expect(response.status).toBe(200);
    const ingested = await channelMessages();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.body).toBe("hello there");
    expect(ingested[0]?.origin).toBe("slack");

    // The agent this app speaks as posts as the bot itself: no name prefix,
    // because in Slack the bot *is* Ada.
    await publishMessage(db, env, {
      attachmentIds: [],
      authorId: adaId,
      authorType: "agent",
      body: "on it",
      channelId,
      workspace,
    });
    // Anyone else sharing the channel keeps theirs.
    await publishMessage(db, env, {
      attachmentIds: [],
      authorId: bobId,
      authorType: "agent",
      body: "me too",
      channelId,
      workspace,
    });

    const posts = slackCalls.filter(
      (call) => call.method === "chat.postMessage"
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      payload: { channel: ADA_CHANNEL, text: "on it" },
      token: ADA_TOKEN,
    });
    expect(posts[1]).toMatchObject({
      payload: { channel: ADA_CHANNEL, text: "*Bob*\nme too" },
      token: ADA_TOKEN,
    });
  });

  test("a message from Slack is never mirrored back to Slack", async () => {
    await post(adaAppId, messageEvent(ADA_CHANNEL, "1.9"));
    await settle();

    expect(
      slackCalls.filter((call) => call.method === "chat.postMessage")
    ).toHaveLength(0);
  });
});
