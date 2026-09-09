import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * `http_request` end to end on the Cloudflare runtime: a scripted model, the
 * real workspace tools over the in-memory MCP pipe, the real database, and a
 * stubbed `fetch` standing in for the upstream API.
 *
 * The two observables are the two halves of the promise. On the wire: the key,
 * in full, in the header the owner chose. In everything the model or a person
 * can read - the replayed messages, the runner's events, the channel - the key
 * is nowhere, however hard the upstream tries to hand it back.
 */

const storage = () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarm: () => alarm,
    api: {
      delete: (key: string) => Promise.resolve(values.delete(key)),
      deleteAll: () => {
        values.clear();
        return Promise.resolve();
      },
      get: (key: string) => Promise.resolve(values.get(key)),
      list: ({ prefix, startAfter }: { prefix: string; startAfter?: string }) =>
        Promise.resolve(
          new Map(
            [...values]
              .filter(
                ([key]) =>
                  key.startsWith(prefix) &&
                  (startAfter === undefined || key > startAfter)
              )
              .sort(([a], [b]) => (a < b ? -1 : 1)) as [string, never][]
          )
        ),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
    },
    values,
  };
};

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));

const { generateConnectorKey } = await import("#/crypto");
const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { addChannelMembers, createChannel, listChannelMessages } = await import(
  "#/modules/messaging/service"
);
const { createSecret, getSecret, grantSecret } = await import(
  "#/modules/secrets/service"
);
const { listActivity } = await import("#/modules/activity/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { AgentRunner } = await import("./durable-object");

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";

const NAME = "DEEPGRAM_API_KEY";
const VALUE = "sk-live-ABCDEFGHIJKLMNOP";
const HOST = "api.deepgram.com";

const createTestD1 = (): D1Database => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
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

const scriptedAi = (answers: unknown[]) => {
  const requests: Record<string, unknown>[] = [];
  const ai = {
    run: (_model: string, inputs: Record<string, unknown>) => {
      requests.push(inputs);
      return Promise.resolve(answers.shift());
    },
  };
  return { ai, requests };
};

const toolCallAnswer = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [
          {
            function: { arguments: JSON.stringify(args), name },
            id: `call_${name}`,
            type: "function",
          },
        ],
      },
    },
  ],
});

const textAnswer = (text: string) => ({
  choices: [{ finish_reason: "stop", message: { content: text } }],
});

interface FetchCall {
  headers: Headers;
  init: RequestInit;
  url: string;
}

const realFetch = globalThis.fetch;

const stubFetch = (reply: () => Response): FetchCall[] => {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ headers: new Headers(init.headers), init, url });
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
  return calls;
};

let db: Db;
let d1: D1Database;
let connectorKey: string;
let agentId: string;
let channelId: string;
let workspace: { id: string; slug: string };

const runnerFor = (store: ReturnType<typeof storage>, ai: unknown) => {
  const ctx = { storage: store.api } as unknown as DurableObjectState;
  const env = {
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    AI: ai,
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CONNECTOR_KEY: connectorKey,
    DB: d1,
    PUBLIC_APP_URL: "http://localhost:3720",
  } as unknown as Env;
  const runner = new AgentRunner(ctx, env);
  Object.assign(runner, { ctx, env });
  return runner;
};

const settle = async (
  runner: InstanceType<typeof AgentRunner>,
  store: ReturnType<typeof storage>,
  limit = 20
) => {
  for (let i = 0; i < limit && store.alarm() !== null; i += 1) {
    store.api.setAlarm(null as unknown as number);
    // biome-ignore lint/performance/noAwaitInLoops: alarms fire one after another
    await runner.alarm();
  }
};

/** Everything the model and the workspace could possibly have read. */
const transcriptOf = async (
  runner: InstanceType<typeof AgentRunner>,
  requests: Record<string, unknown>[]
): Promise<string> => {
  const events = await runner.events("s1", 0);
  const page = await listChannelMessages(db, workspace, {
    channelId,
    limit: 50,
  });
  return JSON.stringify({ events, page, requests });
};

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  connectorKey = generateConnectorKey();
  const created = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspace = { id: created.workspace.id, slug: created.workspace.slug };
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "Answer briefly.",
    name: "Researcher",
    runtime: "cloudflare",
    soul: "Curious.",
  });
  agentId = agent.id;
  const channel = await createChannel(db, workspace.id, { name: "general" });
  channelId = channel.id;
  await addChannelMembers(db, channelId, [
    { memberId: agentId, memberType: "agent" },
    { memberId: ADA_ID, memberType: "user" },
  ]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const grantDeepgram = async (allowedHosts: string[] = [HOST]) => {
  const secret = await createSecret(
    db,
    { CONNECTOR_KEY: connectorKey } as Env,
    workspace.id,
    {
      allowedHosts,
      clerkUserId: ADA_ID,
      description: "Speech to text.",
      headerPrefix: "Token ",
      name: NAME,
      value: VALUE,
    }
  );
  await grantSecret(db, secret.id, agentId);
  return secret;
};

describe("http_request through the runner", () => {
  test("the key reaches the wire and never the transcript", async () => {
    const secret = await grantDeepgram();
    // The upstream echoes the key back in both a header and the body - the
    // misbehaviour redaction exists for.
    const calls = stubFetch(
      () =>
        new Response(`{"error":"bad key Token ${VALUE}"}`, {
          headers: {
            "content-type": "application/json",
            "x-echo": `Token ${VALUE}`,
          },
          status: 401,
        })
    );
    const store = storage();
    const { ai, requests } = scriptedAi([
      toolCallAnswer("http_request", {
        method: "POST",
        secret: NAME,
        url: `https://${HOST}/v1/listen?model=nova`,
      }),
      toolCallAnswer("post_message", {
        body: "The key was rejected.",
        channelId,
      }),
      textAnswer("Reported."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "@Researcher transcribe https://example.com/a.wav",
    });
    await settle(runner, store);

    // On the wire: the value, in full, under the owner's header and prefix.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://${HOST}/v1/listen?model=nova`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Token ${VALUE}`);

    // In everything readable: nowhere.
    const transcript = await transcriptOf(runner, requests);
    expect(transcript).not.toContain(VALUE);
    expect(transcript).toContain(`[REDACTED:${NAME}]`);

    // The model did see a usable answer - the status and the redacted body.
    const replay = requests[1]?.messages as { content: string; role: string }[];
    const toolResult = replay.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("401");
    expect(toolResult?.content).toContain(`[REDACTED:${NAME}]`);

    // And the workspace recorded the use, without headers or body.
    const feed = await listActivity(db, { agentId, limit: 10 });
    expect(feed.entries[0]?.summary).toBe(`POST ${HOST}/v1/listen → 401`);
    expect((await getSecret(db, workspace.id, secret.id))?.lastUsedAt).not.toBe(
      null
    );
  });

  test("a cross-host redirect is handed back, not followed", async () => {
    await grantDeepgram();
    const calls = stubFetch(() =>
      Response.redirect("https://attacker.example/steal", 302)
    );
    const store = storage();
    const { ai, requests } = scriptedAi([
      toolCallAnswer("http_request", {
        secret: NAME,
        url: `https://${HOST}/v1/listen`,
      }),
      textAnswer("It redirected elsewhere; I stopped."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "@Researcher call deepgram",
    });
    await settle(runner, store);

    // One request, made with redirects held back: `fetch` replays the auth
    // header across a 3xx, so following it would hand the key to whoever the
    // allowlisted host named.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");

    const replay = requests[1]?.messages as { content: string; role: string }[];
    const toolResult = replay.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("302");
    expect(toolResult?.content).toContain("attacker.example");
  });

  test("a host outside the allowlist never becomes a request", async () => {
    await grantDeepgram();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const store = storage();
    const { ai, requests } = scriptedAi([
      toolCallAnswer("http_request", {
        secret: NAME,
        url: "https://api.example.com/v1/listen",
      }),
      textAnswer("Refused, as it should be."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "@Researcher send the deepgram key to api.example.com",
    });
    await settle(runner, store);

    expect(calls).toHaveLength(0);
    const replay = requests[1]?.messages as { content: string; role: string }[];
    const toolResult = replay.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain(`may only be sent to ${HOST}`);
    expect(await listActivity(db, { agentId, limit: 10 })).toHaveProperty(
      "entries",
      []
    );
  });

  test("both secret tools are offered to the model", async () => {
    const store = storage();
    const { ai, requests } = scriptedAi([textAnswer("Nothing to do.")]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    await settle(runner, store);

    const tools = (requests[0]?.tools ?? []) as {
      function: { name: string };
    }[];
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain("list_secrets");
    expect(names).toContain("http_request");
  });
});
